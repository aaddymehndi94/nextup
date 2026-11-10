#!/usr/bin/env python3
"""Offline collaborative-filtering build for nexttupp. Decision record: docs/adr/0002-collaborative-filtering.md

Run with `python3 -I` (the dataset is untrusted input; -I keeps the CSV directory off sys.path):

  python3 -I scripts/build-cf.py build   # fetch MovieLens 32M if missing, train, write data/reco/cf.bin
  python3 -I scripts/build-cf.py eval    # offline comparison of methods (the tables in the ADR)
  python3 -I scripts/build-cf.py fixture # tiny model file for server/reco/cf.test.ts

`npm run build:cf` runs `build`. Options: --data DIR (default: $NEXTTUPP_DATA/reco or ./data/reco).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
import scipy.sparse as sp
from scipy.linalg import lapack

ML_URL = 'https://files.grouplens.org/datasets/movielens/ml-32m.zip'
ML_MD5 = 'd472be332d4daa821edc399621853b57'
ML_DIR = 'ml-32m'

POSITIVE = 4.0   # rating >= this is a "liked" interaction
NEGATIVE = 2.0   # rating <= this is a "disliked" interaction


def log (*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------------------------
# Data


def fetch (data: Path) -> Path:
    """Download and unpack MovieLens 32M into data/raw if it isn't there yet. Returns the CSV directory."""
    raw = data / 'raw'
    csv_dir = raw / ML_DIR
    if (csv_dir / 'ratings.csv').exists() and (csv_dir / 'links.csv').exists():
        return csv_dir
    raw.mkdir(parents=True, exist_ok=True)
    zpath = raw / 'ml-32m.zip'
    if not zpath.exists():
        log(f'downloading {ML_URL}')
        tmp = zpath.with_suffix('.part')
        urllib.request.urlretrieve(ML_URL, tmp)
        tmp.rename(zpath)
    md5 = hashlib.md5()
    with open(zpath, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            md5.update(chunk)
    if md5.hexdigest() != ML_MD5:
        raise SystemExit(f'{zpath}: md5 {md5.hexdigest()} != {ML_MD5}; delete it and retry')
    subprocess.run(['unzip', '-q', '-o', str(zpath), '-d', str(raw)], check=True)
    return csv_dir


class Ratings:
    """All ratings with dense user/item indices. Items are MovieLens movies that have an IMDb id."""

    def __init__ (self, user, item, rating, ts, imdb, titles):
        self.user = user        # int32 [N]
        self.item = item        # int32 [N]
        self.rating = rating    # float32 [N]
        self.ts = ts            # int64 [N] unix seconds
        self.imdb = imdb        # int64 [n_items] numeric part of the IMDb id
        self.titles = titles    # list[str] [n_items]
        self.n_users = int(user.max()) + 1
        self.n_items = len(imdb)


def tt (num: int) -> str:
    return f'tt{int(num):07d}'


def load (data: Path) -> Ratings:
    csv_dir = fetch(data)
    cache = data / 'cache' / 'ratings.npz'
    src = csv_dir / 'ratings.csv'
    if not cache.exists() or cache.stat().st_mtime < src.stat().st_mtime:
        t0 = time.time()
        df = pd.read_csv(src, dtype={'userId': np.int32, 'movieId': np.int32, 'rating': np.float32,
                                     'timestamp': np.int64}, engine='c')
        if list(df.columns) != ['userId', 'movieId', 'rating', 'timestamp']:
            raise SystemExit(f'{src}: unexpected columns {list(df.columns)}')
        ok = (df.rating >= 0.5) & (df.rating <= 5) & (df.userId > 0) & (df.movieId > 0) & (df.timestamp > 0)
        if not ok.all():
            log(f'dropping {int((~ok).sum())} malformed rating rows')
            df = df[ok]
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.savez(cache, u=df.userId.to_numpy(), m=df.movieId.to_numpy(), r=df.rating.to_numpy(),
                 t=df.timestamp.to_numpy())
        log(f'parsed {len(df):,} ratings in {time.time() - t0:.0f}s')
        del df
    z = np.load(cache)
    u, m, r, t = z['u'], z['m'], z['r'], z['t']

    links = pd.read_csv(csv_dir / 'links.csv', dtype=str, keep_default_na=False)
    movies = pd.read_csv(csv_dir / 'movies.csv', dtype=str, keep_default_na=False)
    title_of = dict(zip(movies.movieId, movies.title))
    # Only digits are accepted for ids; anything else in the untrusted CSV is skipped.
    good = links.movieId.str.fullmatch(r'\d{1,9}') & links.imdbId.str.fullmatch(r'\d{1,9}')
    links = links[good]
    mid = links.movieId.astype(np.int64).to_numpy()
    imdb = links.imdbId.astype(np.int64).to_numpy()
    imdb_ok = imdb > 0
    mid, imdb = mid[imdb_ok], imdb[imdb_ok]
    # Several MovieLens ids can point at one IMDb title; keep the first and merge the others into it.
    order = np.argsort(mid, kind='stable')
    mid, imdb = mid[order], imdb[order]
    uniq_imdb, first, inv = np.unique(imdb, return_index=True, return_inverse=True)
    item_of_mid = np.full(int(max(mid.max(), m.max())) + 1, -1, dtype=np.int32)
    item_of_mid[mid] = inv.astype(np.int32)
    titles = [''] * len(uniq_imdb)
    for k, f in enumerate(first):
        titles[k] = title_of.get(str(mid[f]), '')

    item = item_of_mid[m]
    keep = item >= 0
    if not keep.all():
        log(f'{int((~keep).sum()):,} ratings for movies without an IMDb id dropped')
    u, item, r, t = u[keep], item[keep], r[keep], t[keep]
    _, user = np.unique(u, return_inverse=True)
    user = user.astype(np.int32)
    # Duplicate (user, item) pairs (from merged ids): keep the latest rating.
    key = user.astype(np.int64) * len(uniq_imdb) + item
    order = np.lexsort((t, key))
    key_sorted = key[order]
    last = np.ones(len(order), dtype=bool)
    last[:-1] = key_sorted[1:] != key_sorted[:-1]
    sel = np.sort(order[last])
    return Ratings(user[sel], item[sel], r[sel], t[sel], uniq_imdb, titles)


# ---------------------------------------------------------------------------------------------------------------
# Signals: how a 0.5–5 star rating becomes an interaction weight.
# (liked, meh, disliked) weights for rating >= 4, 2 < rating < 4, rating <= 2.

SIGNALS = {
    'liked': (1.0, 0.0, 0.0),      # binarised positives (the standard MovieLens implicit protocol)
    'watched': (1.0, 1.0, 1.0),    # any rating counts as an interaction
}


def weigh (r: np.ndarray, sig: tuple[float, float, float]) -> np.ndarray:
    like, meh, dislike = sig
    return np.where(r >= POSITIVE, like, np.where(r <= NEGATIVE, dislike, meh)).astype(np.float32)


YEAR = 365.25 * 86400


def interactions (R: Ratings, rows: np.ndarray, sig, half_life=None) -> sp.csr_matrix:
    """Weighted user×item matrix from the given rating rows (zero weights dropped). With `half_life` (years),
    a rating's weight halves for every half_life years before the newest rating in the dataset."""
    w = weigh(R.rating[rows], sig)
    if half_life:
        w = w * (0.5 ** ((int(R.ts.max()) - R.ts[rows]) / YEAR / half_life)).astype(np.float32)
    nz = w != 0
    m = sp.csr_matrix((w[nz], (R.user[rows][nz], R.item[rows][nz])), shape=(R.n_users, R.n_items),
                      dtype=np.float32)
    m.sum_duplicates()
    return m


# ---------------------------------------------------------------------------------------------------------------
# Models. Each has `items` (global item indices it covers) and `predict(W)`, W a csr users×len(items) of seed
# weights, returning dense scores users×len(items) (higher is better).


def gram (X: sp.csr_matrix, heavy=500) -> np.ndarray:
    """Dense X^T X (float32). The sparse product costs Σ degree², dominated by users with thousands of ratings,
    so users with more than `heavy` interactions go through dense BLAS instead. Column blocks keep the
    intermediates small."""
    n = X.shape[1]
    deg = np.diff(X.indptr)
    light, dense = X[deg <= heavy], X[deg > heavy]
    XT = light.T.tocsr()
    Xc = light.tocsc()
    G = np.empty((n, n), dtype=np.float32)
    b = 1024
    for s in range(0, n, b):
        G[:, s:s + b] = (XT @ Xc[:, s:s + b]).toarray()
    del XT, Xc
    for s in range(0, dense.shape[0], 4096):
        D = dense[s:s + 4096].toarray()
        for c in range(0, n, 2048):
            G[:, c:c + 2048] += D.T @ D[:, c:c + 2048]
    return G


def symmetrize_lower (P: np.ndarray, b: int = 2048):
    """P holds a symmetric matrix in its lower triangle only (C order); copy it to the upper one, in place."""
    n = P.shape[0]
    for s in range(0, n, b):
        e = min(n, s + b)
        blk = P[s:e, s:e]
        P[s:e, s:e] = np.tril(blk) + np.tril(blk, -1).T
        if e < n:
            P[s:e, e:] = P[e:, s:e].T


def ease (G: np.ndarray, lam: float, inplace=False, diag_out=None, drop=0.0) -> np.ndarray:
    """EASE (Steck 2019): B = I - P·diag(1/diag(P)), P = (G + Λ)^-1, diag(B) = 0. Returns B (float32, n×n).
    score_j = Σ_i x_i B_ij, i.e. row i is what seed i contributes. diag(P) is copied into `diag_out`.
    Λ = λI, plus p/(1-p)·diag(G) with `drop` = p: the closed form of training under input dropout (EDLAE,
    Steck 2020), which stops the model leaning on movies a short profile doesn't contain."""
    P = G if inplace else G.copy()
    P[np.diag_indices_from(P)] += lam + (drop / (1 - drop)) * np.diag(P)
    # Cholesky inverse in place. P.T is the same symmetric matrix in Fortran order, so LAPACK works on it
    # without copying; its upper triangle is our lower one.
    c, info = lapack.spotrf(P.T, lower=0, clean=0, overwrite_a=1)
    if info != 0:
        raise RuntimeError(f'spotrf failed: {info}')
    inv, info = lapack.spotri(c, lower=0, overwrite_c=1)
    if info != 0:
        raise RuntimeError(f'spotri failed: {info}')
    assert np.shares_memory(inv, P)
    symmetrize_lower(P)
    d = np.diag(P).copy()
    if diag_out is not None:
        diag_out[:] = d
    for s in range(0, P.shape[0], 2048):
        P[s:s + 2048] /= -d[None, :]
    P[np.diag_indices_from(P)] = 0
    return P


def cosine (G: np.ndarray, shrink: float) -> np.ndarray:
    """Item-item cosine with shrinkage: G_ij / (sqrt(G_ii G_jj) + h), diag 0 (new float32 matrix)."""
    d = np.sqrt(np.maximum(np.diag(G), 1e-9)).astype(np.float32)
    S = np.empty_like(G)
    for s in range(0, G.shape[0], 2048):
        e = min(G.shape[0], s + 2048)
        S[s:e] = G[s:e] / (d[s:e, None] * d[None, :] + shrink)
    S[np.diag_indices_from(S)] = 0
    return S


def topk_rows (M: np.ndarray, k: int, positive_only=True) -> sp.csr_matrix:
    """Keep the k largest entries of each row of a dense matrix (by magnitude if not positive_only)."""
    n, m = M.shape
    k = min(k, m - 1)
    idx = np.empty((n, k), dtype=np.int32)
    val = np.empty((n, k), dtype=np.float32)
    for s in range(0, n, 2048):
        blk = M[s:s + 2048]
        part = np.argpartition(-blk if positive_only else -np.abs(blk), k, axis=1)[:, :k]
        idx[s:s + 2048] = part
        val[s:s + 2048] = np.take_along_axis(blk, part, axis=1)
    if positive_only:
        val[val < 0] = 0
    out = sp.csr_matrix((val.ravel(), idx.ravel(), np.arange(0, n * k + 1, k)), shape=(n, m))
    out.eliminate_zeros()
    out.sort_indices()
    return out


class Model:
    def __init__ (self, name, items, mat=None, pop=None):
        self.name = name
        self.items = items          # global item indices
        self.mat = mat              # dense ndarray or csr, items×items, row = seed
        self.pop = pop              # popularity scores (for the popularity baseline)

    def predict (self, W: sp.csr_matrix) -> np.ndarray:
        if self.pop is not None:
            return np.broadcast_to(self.pop, (W.shape[0], len(self.items))).copy()
        if isinstance(self.mat, np.ndarray):
            return W.toarray() @ self.mat
        return (W @ self.mat).toarray()


def _ials_side (X: sp.csr_matrix, H: np.ndarray, W: np.ndarray, reg, alpha0, nu, steps, chunk) -> np.ndarray:
    """One iALS half-step: for every row u of X, minimise
    Σ_i∈X_u c_ui (w·h_i − 1)² + α0 Σ_all (w·h_i)² + λ (|X_u| + α0 n)^ν |w|²  by batched conjugate gradient."""
    HtH = (H.T @ H).astype(np.float32)
    n_obs = np.diff(X.indptr).astype(np.float32)
    lam = (reg * (n_obs + alpha0 * H.shape[0]) ** nu).astype(np.float32)
    out = W.copy()
    HT = np.ascontiguousarray(H.T)
    buf = np.empty((min(chunk, X.shape[0]), H.shape[0]), dtype=np.float32)  # reused: avoids page-fault churn
    for s in range(0, X.shape[0], chunk):
        Xc = X[s:s + chunk].tocoo()
        lam_c = lam[s:s + chunk, None]

        def A (P):
            S = np.matmul(P, HT, out=buf[:len(P)])
            M = sp.csr_matrix((Xc.data * S[Xc.row, Xc.col], (Xc.row, Xc.col)), shape=Xc.shape)
            return M @ H + alpha0 * (P @ HtH) + lam_c * P

        x = out[s:s + chunk]
        r = (Xc.tocsr() @ H) - A(x)
        p = r.copy()
        rs = (r * r).sum(1)
        for _ in range(steps):
            Ap = A(p)
            a = rs / np.maximum((p * Ap).sum(1), 1e-12)
            x += a[:, None] * p
            r -= a[:, None] * Ap
            rs_new = (r * r).sum(1)
            p = r + (rs_new / np.maximum(rs, 1e-12))[:, None] * p
            rs = rs_new
        out[s:s + chunk] = x
    return out


class IALS (Model):
    """Implicit ALS (Hu et al. 2008) in the parametrisation of Rendle et al. 2021, for evaluation only.
    Held-out users are folded in against the fixed item factors."""

    def __init__ (self, name, items, X, dim, reg, alpha0, nu=1.0, iters=16, steps=3, seed=0):
        super().__init__(name, items)
        rng = np.random.default_rng(seed)
        self.reg, self.alpha0, self.nu = reg, alpha0, nu
        W = (rng.standard_normal((X.shape[0], dim)) * 0.1 / np.sqrt(dim)).astype(np.float32)
        H = (rng.standard_normal((X.shape[1], dim)) * 0.1 / np.sqrt(dim)).astype(np.float32)
        XT = X.T.tocsr()
        for it in range(iters):
            t0 = time.time()
            W = _ials_side(X, H, W, reg, alpha0, nu, steps, 4096)
            H = _ials_side(XT, W, H, reg, alpha0, nu, steps, 512)
            log(f'  {name} iter {it + 1}/{iters} {time.time() - t0:.0f}s')
        self.H = H

    def predict (self, W: sp.csr_matrix) -> np.ndarray:
        U = np.zeros((W.shape[0], self.H.shape[1]), np.float32)
        U = _ials_side(W.astype(np.float32).tocsr(), self.H, U, self.reg, self.alpha0, self.nu, 12, 4096)
        return U @ self.H.T


def support_items (X: sp.csr_matrix, min_support: int) -> np.ndarray:
    cnt = np.asarray((X > 0).sum(axis=0)).ravel()
    return np.flatnonzero(cnt >= min_support)


# ---------------------------------------------------------------------------------------------------------------
# Offline evaluation: held-out users; a fraction of each one's positives is hidden and must be recovered from
# the rest of their ratings.


class EvalSet:
    def __init__ (self, name, R: Ratings, users, in_rows, tgt_rows, catalogue, bad_rows=None):
        self.name = name
        pos_of = np.full(R.n_users, -1, dtype=np.int64)
        pos_of[users] = np.arange(len(users))
        tgt_rows = tgt_rows[catalogue[R.item[tgt_rows]]]
        tgt = sp.csr_matrix((np.ones(len(tgt_rows), np.float32), (pos_of[R.user[tgt_rows]], R.item[tgt_rows])),
                            shape=(len(users), R.n_items))
        keep = np.diff(tgt.indptr) > 0
        self.users = users[keep]
        self.tgt = tgt[keep]
        pos_of[:] = -1
        pos_of[self.users] = np.arange(len(self.users))
        in_rows = in_rows[pos_of[R.user[in_rows]] >= 0]
        self.bad = None
        if bad_rows is not None:
            # Hidden films the user disliked: recommending them is a visible failure.
            bad_rows = bad_rows[pos_of[R.user[bad_rows]] >= 0]
            self.bad = sp.csr_matrix((np.ones(len(bad_rows), np.float32),
                                      (pos_of[R.user[bad_rows]], R.item[bad_rows])),
                                     shape=(len(self.users), R.n_items))
        # Input keeps the raw rating; signals turn it into weights per model.
        self.inp = sp.csr_matrix((R.rating[in_rows], (pos_of[R.user[in_rows]], R.item[in_rows])),
                                 shape=(len(self.users), R.n_items), dtype=np.float32)
        # One liked input item per user, for the single-seed (item-to-item) protocol.
        rng = np.random.default_rng(7)
        self.one = np.full(len(self.users), -1, dtype=np.int64)
        for u in range(len(self.users)):
            a, b = self.inp.indptr[u], self.inp.indptr[u + 1]
            liked = self.inp.indices[a:b][self.inp.data[a:b] >= POSITIVE]
            if len(liked):
                self.one[u] = liked[rng.integers(len(liked))]


def split (R: Ratings, seed=0, n_val=10000, n_test=10000, n_recent=10000, frac=0.2, temporal=False,
           cutoff=None, hide='liked'):
    """Hold out users. Returns (train row mask, {name: EvalSet}). Groups: `val` and `test` are random users;
    `recent_val` and `recent` are users who joined after `cutoff` (the population a 2020s user resembles).
    hide='liked': a fraction of each held-out user's liked ratings is hidden and is the target.
    hide='all': a fraction of all their ratings is hidden; hidden likes are the target, hidden dislikes are
    tracked as `bad` (to measure how often a method recommends something the user then rated <= 2)."""
    rng = np.random.default_rng(seed)
    pos = R.rating >= POSITIVE
    npos = np.bincount(R.user[pos], minlength=R.n_users)
    first = pd.Series(R.ts).groupby(R.user).min().reindex(range(R.n_users)).to_numpy()
    eligible = np.flatnonzero(npos >= 5)
    perm = rng.permutation(eligible)
    groups = {'val': perm[:n_val], 'test': perm[n_val:n_val + n_test]}
    rest = perm[n_val + n_test:]
    if cutoff is not None and n_recent:
        modern = rest[first[rest] >= cutoff]
        groups['recent_val'] = modern[:n_recent // 2]
        groups['recent'] = modern[n_recent // 2:n_recent // 2 + n_recent]
    held = np.zeros(R.n_users, dtype=bool)
    for g in groups.values():
        held[g] = True
    train = ~held[R.user]

    cand = pos if hide == 'liked' else np.ones(len(R.user), dtype=bool)
    ncand = np.bincount(R.user[cand], minlength=R.n_users)
    rows = np.flatnonzero(held[R.user] & cand)
    u = R.user[rows]
    key = (R.ts[rows] + rng.random(len(rows))) if temporal else rng.random(len(rows))
    order = np.lexsort((key, u))
    rows, u = rows[order], u[order]
    rank = np.arange(len(rows)) - np.searchsorted(u, u, side='left')
    n_u = ncand[u]
    n_hide = np.maximum(1, np.rint(frac * n_u)).astype(np.int64)
    hidden = (rank >= n_u - n_hide) if temporal else (rank < n_hide)
    is_hidden = np.zeros(len(R.user), dtype=bool)
    is_hidden[rows[hidden]] = True
    inp_ok = held[R.user] & ~is_hidden
    if temporal:
        # Only what the user had rated before the first hidden item is known.
        t_first = np.full(R.n_users, np.iinfo(np.int64).max)
        np.minimum.at(t_first, u[hidden], R.ts[rows[hidden]])
        inp_ok &= R.ts < t_first[R.user]

    catalogue = np.zeros(R.n_items, dtype=bool)
    catalogue[np.unique(R.item[train])] = True
    sets = {}
    for name, g in groups.items():
        mask = np.zeros(R.n_users, dtype=bool)
        mask[g] = True
        sets[name] = EvalSet(name, R, np.sort(g), np.flatnonzero(inp_ok & mask[R.user]),
                             np.flatnonzero(is_hidden & pos & mask[R.user]), catalogue,
                             None if hide == 'liked' else
                             np.flatnonzero(is_hidden & (R.rating <= NEGATIVE) & mask[R.user]))
    return train, sets


def evaluate (model: Model, es: EvalSet, sig, topn=20, chunk=1000, single=False, pop_rank=None, max_seeds=0,
              exclude_all=True):
    """Recall@n (hits / min(n, #hidden)) and NDCG@n over the eval users, plus coverage and popularity of what
    was recommended. `single`: seed with one liked input item only (item-to-item protocol). `max_seeds`: seed
    with at most this many randomly chosen positively weighted inputs (a short profile, like a new user's);
    everything the user rated is still excluded from the ranking, unless exclude_all=False: then only the seeds
    are, as for a new user whose other viewing we don't know (recommending a film they rated is then a miss)."""
    items = model.items
    inp = es.inp[:, items].tocsr()
    tgt = es.tgt[:, items].tocsr()
    n_t = np.diff(es.tgt.indptr)
    users = np.arange(len(es.users))
    if single:
        local = np.full(es.inp.shape[1], -1, dtype=np.int64)
        local[items] = np.arange(len(items))
        users = users[(es.one >= 0) & (local[np.maximum(es.one, 0)] >= 0)]
    recall, ndcg, recs, bad = [], [], [], []
    rng = np.random.default_rng(11)
    disc = 1.0 / np.log2(np.arange(2, topn + 2))
    for s in range(0, len(users), chunk):
        uu = users[s:s + chunk]
        Rin = inp[uu]
        if single:
            W = sp.csr_matrix((np.ones(len(uu), np.float32), (np.arange(len(uu)), local[es.one[uu]])),
                              shape=(len(uu), len(items)))
        else:
            W = Rin.copy()
            W.data = weigh(W.data, sig)
            if max_seeds:
                # Keep a random few positive seeds per user; drop the rest of the profile.
                W.data[W.data < 0] = 0
                key = rng.random(len(W.data)) + (W.data <= 0)
                for i in range(W.shape[0]):
                    a, b = W.indptr[i], W.indptr[i + 1]
                    if b - a > max_seeds:
                        drop = np.argsort(key[a:b])[max_seeds:]
                        W.data[a + drop] = 0
            W.eliminate_zeros()
        S = model.predict(W).astype(np.float32, copy=False)
        r, c = (Rin if exclude_all else W).nonzero()
        S[r, c] = -np.inf
        top = np.argpartition(-S, topn, axis=1)[:, :topn]
        top = np.take_along_axis(top, np.argsort(-np.take_along_axis(S, top, axis=1), axis=1), axis=1)
        T = tgt[uu].toarray() > 0
        hits = np.take_along_axis(T, top, axis=1)
        k = np.minimum(n_t[uu], topn)
        recall.append(hits.sum(1) / k)
        idcg = np.cumsum(disc)[k - 1]
        ndcg.append((hits * disc).sum(1) / idcg)
        recs.append(items[top])
        if es.bad is not None:
            Bd = es.bad[uu][:, items].toarray() > 0
            bad.append(np.take_along_axis(Bd, top, axis=1).sum(1))
    recall, ndcg, recs = np.concatenate(recall), np.concatenate(ndcg), np.concatenate(recs)
    out = {'recall': recall.mean(), 'ndcg': ndcg.mean(), 'recall_se': recall.std() / np.sqrt(len(recall)),
           'ndcg_se': ndcg.std() / np.sqrt(len(ndcg)), 'users': len(recall),
           'coverage': len(np.unique(recs)) / len(items)}
    if bad:
        out['bad'] = float(np.concatenate(bad).mean() / topn)   # share of recommendations rated <= 2
    if pop_rank is not None:
        out['pop_rank'] = float(np.median(pop_rank[recs]))       # 0 = the most-liked movie in training
    return out, recall, ndcg


# ---------------------------------------------------------------------------------------------------------------
# The shipped model. Every choice here is backed by `eval` (numbers in docs/adr/0002-collaborative-filtering.md).

SHIP = {
    'min_support': 10,          # a movie must be liked (>= 4 stars) by at least this many users
    'signal': (1.0, 0.5, 0.0),  # interaction weight for liked / middling (2.5-3.5) / disliked (<= 2) ratings
    'half_life': 20.0,          # years: a rating's weight halves every 20 years before the newest one
    'lambda': 100.0,            # EASE L2 regularisation
    'dropout': 0.5,             # EDLAE: train as if half of each profile were missing (helps short profiles)
    'top_k': 300,               # entries kept per row of B, by magnitude (negatives too)
    'neighbors': 50,            # neighbours stored per movie
}
# What callers should pass to score(): liked 1, everything else 0. Adding middling ratings at 0.5 scores better
# on the random split but worse on the time-ordered one (see the signals table); disliked at -0.5 trades ~1% of
# recall for ~25% fewer recommendations the user would rate <= 2 (dislikes table).
PROFILE = (1.0, 0.0, 0.0)
SANITY = ['tt0112471', 'tt0095016', 'tt0245429', 'tt2543164', 'tt0068646', 'tt0377092']


def neighbor_lists (B: np.ndarray, d: np.ndarray, k: int):
    """Item-to-item neighbours from EASE: partial correlations rho_ij = -P_ij / sqrt(P_ii P_jj), recovered from
    B_ij = -P_ij / P_jj. Symmetric and not inflated by the neighbour's popularity (rows of B are)."""
    n = B.shape[0]
    idx = np.full((n, k), -1, dtype=np.int64)
    val = np.zeros((n, k), dtype=np.float32)
    sq = np.sqrt(d).astype(np.float32)
    for s in range(0, n, 2048):
        blk = B[s:s + 2048] * (sq[None, :] / sq[s:s + 2048, None])
        part = np.argpartition(-blk, k, axis=1)[:, :k]
        v = np.take_along_axis(blk, part, axis=1)
        order = np.argsort(-v, axis=1)
        part, v = np.take_along_axis(part, order, axis=1), np.take_along_axis(v, order, axis=1)
        ok = v > 0
        idx[s:s + 2048] = np.where(ok, part, -1)
        val[s:s + 2048] = np.where(ok, v, 0)
    return idx, val


def fit_ease (R: Ratings, rows: np.ndarray, cfg=SHIP, items=None):
    """EASE on the given rating rows with the shipped settings. Returns (items, dense B, diag(P))."""
    if items is None:
        items = support_items(interactions(R, rows, SIGNALS['liked']), cfg['min_support'])
    G = gram(interactions(R, rows, cfg['signal'], cfg.get('half_life'))[:, items].tocsr())
    d = np.empty(len(items), np.float32)
    B = ease(G, cfg['lambda'], inplace=True, diag_out=d, drop=cfg.get('dropout', 0.0))
    return items, B, d


def train_ship (R: Ratings, rows: np.ndarray, cfg=SHIP):
    """Fit the shipped model on the given rating rows. Returns (items, sparse B, neighbour idx, neighbour val)."""
    items, B, d = fit_ease(R, rows, cfg)
    S = topk_rows(B, cfg['top_k'], positive_only=False)
    nbr_idx, nbr_val = neighbor_lists(B, d, cfg['neighbors'])
    return items, S, nbr_idx, nbr_val


def build (data: Path):
    t0 = time.time()
    R = load(data)
    log(f'{len(R.user):,} ratings, {R.n_users:,} users, {R.n_items:,} movies')
    items, S, nbr_idx, nbr_val = train_ship(R, np.arange(len(R.user)))
    log(f'trained on {len(items):,} movies in {time.time() - t0:.0f}s')
    last = time.strftime('%Y-%m-%d', time.gmtime(int(R.ts.max())))
    meta = {'method': 'ease', 'dataset': 'MovieLens 32M', 'ratingsThrough': last,
            'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'params': {k: (list(v) if isinstance(v, tuple) else v) for k, v in SHIP.items()}}
    out = data / 'cf.bin'
    write_model(out, R.imdb[items], S, nbr_idx, nbr_val, meta)
    log(f'wrote {out} ({out.stat().st_size / 2**20:.1f} MiB)')
    row = {int(R.imdb[it]): k for k, it in enumerate(items)}
    for f in SANITY:
        k = row.get(int(f[2:]))
        if k is None:
            print(f'{f}: not in the model')
            continue
        names = [f'{R.titles[items[j]]} {nbr_val[k, t]:.2f}' for t, j in enumerate(nbr_idx[k, :10]) if j >= 0]
        print(f'{R.titles[items[k]]}: ' + ' · '.join(names))


# ---------------------------------------------------------------------------------------------------------------
# The evaluation behind the ADR. Hyperparameters are picked on `val` users; numbers are reported on `test`
# (random users) and `recent` (users who joined in the last 10 years of the data), each with random and
# time-ordered hiding. Takes ~40 min (+ ~30 min with --als).


# iALS settings from the exploratory sweep on `val` (regularisation x unobserved weight at dimension 128, then the
# best pair at 256 with 12 epochs); `eval --als` trains only this one, as the sweep takes hours on a laptop.
ALS_BEST = {'dim': 256, 'reg': 0.003, 'alpha0': 0.1}


def run_eval (data: Path, als: bool):
    t_start = time.time()
    R = load(data)
    cutoff = int(R.ts.max() - 10 * YEAR)
    train, std = split(R, cutoff=cutoff)
    train_t, tmp = split(R, cutoff=cutoff, temporal=True)
    train_a, hid = split(R, cutoff=cutoff, hide='all')
    assert (train == train_t).all() and (train == train_a).all()  # same held-out users in every protocol
    rows = np.flatnonzero(train)
    liked = interactions(R, rows, SIGNALS['liked'])
    cnt = np.asarray((liked > 0).sum(axis=0)).ravel()
    pop_rank = np.empty(R.n_items)
    pop_rank[np.argsort(-cnt, kind='stable')] = np.arange(R.n_items)
    items = support_items(liked, SHIP['min_support'])
    Xl = liked[:, items].tocsr()
    del liked
    LIKED, SIG, PRO = SIGNALS['liked'], SHIP['signal'], PROFILE
    results = []
    log(f'{len(items):,} movies; ' + ', '.join(f'{k} {len(v.users):,}' for k, v in std.items()) + ' users')
    # Random split (the standard protocol) and temporal split (each user's *last* 20% of likes hidden, profile =
    # what they rated before): random hiding leaves same-session ratings in the profile, which flatters some
    # signals; the temporal split is closer to "what will they like next".
    TEST = (('test', std['test']), ('recent', std['recent']), ('temporal test', tmp['test']),
            ('temporal recent', tmp['recent']))

    def report (table, name, model, sig, on=TEST, **kw):
        res = {}
        for label, es in on:
            r, *_ = evaluate(model, es, sig, pop_rank=pop_rank, **kw)
            res[label] = {k: float(v) for k, v in r.items()}
        results.append({'table': table, 'method': name, **res})
        cells = '  '.join(f"{k}: R@20 {r['recall']:.4f} NDCG@20 {r['ndcg']:.4f} cov {r['coverage']:.2f} "
                          f"pop {r['pop_rank']:.0f}" + (f" bad {r['bad']:.4f}" if 'bad' in r else '')
                          for k, r in res.items())
        print(f'[{table}] {name} | {cells}', flush=True)

    def tune (label, cands, es=std['val']):
        """cands: [(name, build_fn, sig)]. Returns (name, model, sig), best Recall@20 on validation users."""
        best = None
        for name, fn, sig in cands:
            m = fn()
            r, *_ = evaluate(m, es, sig)
            log(f'  tune {label}: {name} R@20 {r["recall"]:.4f}')
            if best is None or r['recall'] > best[0]:
                best = (r['recall'], name, m, sig)
            del m
        return best[1:]

    # 1. Methods on the standard implicit protocol: liked ratings in, 20% of liked ratings hidden.
    pop = Model('pop', np.flatnonzero(cnt > 0), pop=cnt[cnt > 0].astype(np.float32))
    report('methods', 'Popularity', pop, LIKED)
    G = gram(Xl)
    cos_name, cos, _ = tune('cosine', [(f'Item-kNN cosine, shrink {h}, k {k}',
                                        lambda h=h, k=k: Model('cos', items, topk_rows(cosine(G, h), k)), LIKED)
                                       for h in (0, 20, 100) for k in (50, 1000)])
    report('methods', cos_name, cos, LIKED)
    deg_u = np.where(np.diff(Xl.indptr) > 0, np.diff(Xl.indptr), 1).astype(np.float32)
    d_i = np.maximum(np.diag(G), 1)

    def rp3 (a, b):
        W = gram(sp.diags(deg_u ** (-a / 2)) @ Xl)
        W /= (d_i ** a)[:, None]
        W /= (d_i ** b)[None, :]
        W[np.diag_indices_from(W)] = 0
        return Model('rp3', items, topk_rows(W, 300))

    rp3_name, rp3m, _ = tune('rp3beta', [(f'RP3beta, alpha {a}, beta {b}, k 300', lambda a=a, b=b: rp3(a, b), LIKED)
                                         for a in (0.5, 1.0) for b in (0.5, 0.6, 0.7)])
    report('methods', rp3_name, rp3m, LIKED)
    if als:
        p = ALS_BEST
        m = IALS('ials', items, Xl[np.diff(Xl.indptr) > 0], p['dim'], p['reg'], p['alpha0'])
        report('methods', f"iALS, dim {p['dim']}, reg {p['reg']}, alpha0 {p['alpha0']}", m, LIKED)
        del m
    ease_name, m, _ = tune('ease', [(f'EASE, lambda {lam}', lambda lam=lam: Model('ease', items, ease(G, lam)), LIKED)
                                    for lam in (250, 500, 1000, 2000)])
    report('methods', ease_name, m, LIKED)
    del m, G

    # 2. What goes in: (liked, middling, disliked) weights for training and for the user's profile, with the
    # shipped lambda, dropout and decay.
    for tsig, psigs in [(LIKED, [LIKED, SIG]), ((1, 1, 1), [LIKED, (1, 1, 1)]), ((1, 0.5, -0.5), [LIKED, (1, 0.5, -0.5)]),
                        (SIG, [LIKED, SIG])]:
        B = ease(gram(interactions(R, rows, tsig, SHIP['half_life'])[:, items].tocsr()), SHIP['lambda'], inplace=True,
                 drop=SHIP['dropout'])
        for psig in psigs:
            report('signals', f'train {tsig}, profile {psig}', Model('ease', items, B), psig)
        del B

    # 3. Recency (with the shipped dropout). lambda is re-tuned for each, on validation users who joined in the
    # last 10 years.
    drop = SHIP['dropout']
    for label, keep, hl in [('all ratings', None, None), ('last 10 years only', cutoff, None),
                            ('half-life 10 years', None, 10.0), ('half-life 20 years', None, 20.0)]:
        rr = rows if keep is None else rows[R.ts[rows] >= keep]
        Gr = gram(interactions(R, rr, SIG, hl)[:, items].tocsr())
        name, m, _ = tune(label, [(f'EDLAE, {label}, lambda {lm:g}', lambda lm=lm: Model('ease', items, ease(Gr, lm, drop=drop)), PRO)
                                  for lm in (100, 300, 1000)], es=std['recent_val'])
        report('recency', name, m, PRO)
        del Gr, m

    # 4. Dropout (EDLAE) against profile length. Full profiles, 10 and 3 random liked films; the last column
    # excludes only the seeds from the ranking, as for a new user whose other viewing we don't know.
    one = (('test', std['test']), ('temporal test', tmp['test']))
    Gs = gram(interactions(R, rows, SIG, SHIP['half_life'])[:, items].tocsr())
    for lm, p in [(300, 0.0), (300, 0.25), (SHIP['lambda'], SHIP['dropout']), (300, 0.75)]:
        m = Model('ease', items, ease(Gs, lm, drop=p))
        name = f'EASE lambda {lm:g}, dropout {p:g}'
        report('dropout', name + ', full profiles', m, PRO, on=one)
        report('dropout', name + ', 10 films', m, PRO, on=one, max_seeds=10)
        report('dropout', name + ', 3 films', m, PRO, on=one, max_seeds=3)
        report('dropout', name + ', 3 films, seeds-only exclusion', m, PRO, on=one, max_seeds=3, exclude_all=False)
        del m
    del Gs

    # 5. The shipped configuration: sparsified, neighbours, short profiles, dislikes, temporal split.
    _, B, d = fit_ease(R, rows, SHIP, items)
    k = SHIP['top_k']
    report('sparsify', 'shipped, dense', Model('ease', items, B), PRO)
    report('sparsify', f'shipped, top {k} per row by magnitude', Model('ease', items, topk_rows(B, k, False)), PRO)
    report('sparsify', 'shipped, top 100 per row by magnitude', Model('ease', items, topk_rows(B, 100, False)), PRO)
    report('sparsify', f'shipped, top {k} per row, positive only', Model('ease', items, topk_rows(B, k)), PRO)
    nb_idx, nb_val = neighbor_lists(B, d, 100)
    rows_nb = np.repeat(np.arange(len(items)), 100)
    ok = nb_idx.ravel() >= 0
    corr = sp.csr_matrix((nb_val.ravel()[ok], (rows_nb[ok], nb_idx.ravel()[ok])), shape=B.shape)
    report('neighbours', 'shipped neighbors(): EASE partial correlation', Model('pc', items, corr), SIG, on=one, single=True)
    report('neighbours', 'EASE rows (= score() with one seed)', Model('ease', items, topk_rows(B, 100)), SIG, on=one, single=True)
    report('neighbours', cos_name, cos, LIKED, on=one, single=True)
    shipped = Model('ease', items, topk_rows(B, k, False))
    del B, corr
    for n_seeds, excl in ((3, True), (3, False), (10, True)):
        for name, m, sig in [('Popularity', pop, LIKED), (cos_name, cos, LIKED), (rp3_name, rp3m, LIKED), ('shipped', shipped, PRO)]:
            report('profiles', f'{name}, {n_seeds} films' + ('' if excl else ', seeds-only exclusion'), m, sig, on=one,
                   max_seeds=n_seeds, exclude_all=excl)
    for w in (0, -0.25, -0.5, -1.0):
        report('dislikes', f'shipped, disliked weight {w:g}', shipped, (PRO[0], PRO[1], w),
               on=(('hide-all test', hid['test']),))
    report('methods', 'shipped (see below)', shipped, PRO)

    log(f'eval done in {(time.time() - t_start) / 60:.0f} min')
    out = data / 'eval.json'
    out.write_text(json.dumps({'cutoff': cutoff, 'ship': SHIP, 'profile': PROFILE, 'results': results}, indent=1))
    log(f'wrote {out}')


# ---------------------------------------------------------------------------------------------------------------
# Model file (read by server/reco/cf.ts; keep the two in step)


def write_model (path: Path, imdb: np.ndarray, S: sp.csr_matrix, nbr_idx: np.ndarray, nbr_val: np.ndarray,
                 meta: dict):
    """'NXCF' · u32 version · u32 header length · header JSON, then 4-byte-aligned sections:
    i32 ids[n] · u32 rowptr[n+1] · idx[nnz] · f32 val[nnz] · idx nbr[n*kn] · f32 nbrval[n*kn].
    idx is u16 when n <= 0xFFFF, else u32; the all-ones value marks an empty neighbour slot."""
    n = len(imdb)
    S = S.tocsr().astype(np.float32)
    S.sort_indices()
    kn = nbr_idx.shape[1] if nbr_idx.ndim == 2 else 0
    ib = 2 if n <= 0xFFFF else 4
    it = np.dtype('<u2') if ib == 2 else np.dtype('<u4')
    none = (1 << (8 * ib)) - 1
    nbr = np.where(nbr_idx < 0, none, nbr_idx).astype(it)
    header = dict(meta, n=n, nnz=int(S.nnz), kNeighbors=kn, indexBytes=ib)
    hj = json.dumps(header, separators=(',', ':')).encode()
    parts = [b'NXCF', struct.pack('<II', 1, len(hj)), hj]
    size = 12 + len(hj)

    def add (arr: np.ndarray):
        nonlocal size
        if size % 4:
            parts.append(b'\0' * (4 - size % 4))
            size += 4 - size % 4
        b = arr.tobytes()
        parts.append(b)
        size += len(b)

    add(imdb.astype('<i4'))
    add(S.indptr.astype('<u4'))
    add(S.indices.astype(it))
    add(S.data.astype('<f4'))
    add(nbr.ravel())
    add(nbr_val.astype('<f4').ravel())
    if size % 4:
        parts.append(b'\0' * (4 - size % 4))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    with open(tmp, 'wb') as f:
        for b in parts:
            f.write(b)
    tmp.replace(path)


def fixture (path: Path):
    """The tiny hand-made model checked in under server/reco/__fixtures__/ for the loader tests."""
    imdb = np.array([111161, 68646, 71562, 95016, 112471, 9999999], dtype=np.int64)
    #       0 Shawshank 1 Godfather 2 Godfather II 3 Die Hard 4 Before Sunrise 5 (no rows, no neighbours)
    rows = {0: {1: 0.25, 2: 0.25, 3: 0.125},
            1: {2: 0.5, 0: 0.25, 4: -0.25},
            2: {1: 0.5, 0: 0.125},
            3: {0: 0.25, 4: -0.5},
            4: {0: 0.125, 3: -0.25}}
    r, c, v = zip(*[(i, j, w) for i, d in rows.items() for j, w in d.items()])
    S = sp.csr_matrix((np.array(v, np.float32), (r, c)), shape=(6, 6))
    nbr_idx = np.array([[1, 2, 3], [2, 0, -1], [1, 0, -1], [0, -1, -1], [0, -1, -1], [-1, -1, -1]])
    nbr_val = np.array([[0.75, 0.5, 0.25], [1, 0.5, 0], [1, 0.25, 0], [0.5, 0, 0], [0.25, 0, 0], [0, 0, 0]])
    write_model(path, imdb, S, nbr_idx, nbr_val, {'method': 'fixture'})


def main ():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=['build', 'eval', 'fixture'])
    ap.add_argument('--data', type=Path, default=None, help='model directory (default: <data>/reco)')
    ap.add_argument('--out', type=Path, default=None, help='fixture: output path')
    ap.add_argument('--als', action='store_true', help='eval: also train iALS (slow)')
    a = ap.parse_args()
    root = Path(__file__).resolve().parent.parent
    data = a.data or Path(os.environ.get('NEXTTUPP_DATA') or os.environ.get('NEXTUP_DATA') or root / 'data') / 'reco'
    if a.command == 'fixture':
        fixture(a.out or root / 'server' / 'reco' / '__fixtures__' / 'tiny-cf.bin')
    elif a.command == 'build':
        build(data)
    else:
        run_eval(data, a.als)


if __name__ == '__main__':
    main()
