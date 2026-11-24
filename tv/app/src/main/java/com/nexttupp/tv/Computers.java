package com.nexttupp.tv;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Finds nexttupp on the home network and pairs with it (server/lan/routes.ts: GET /tv/hello, POST /tv/pair).
 *
 * It asks every address on this TV's own subnet directly, over plain HTTP. Multicast (mDNS) isn't used: some
 * home Wi-Fi drops it, and a direct look at a /24 takes about two seconds.
 */
final class Computers {
    static final int PORT = 4545;
    private static final int THREADS = 64;
    /** This app's versionName, set at start (for the User-Agent). */
    static volatile String version = "0";

    /** A computer running nexttupp, as /tv/hello describes it. */
    static final class Computer {
        final String url;
        final String id;
        final String name;
        /** "Let phones play from this computer" is on (and the computer is signed in). */
        final boolean on;

        Computer(String url, String id, String name, boolean on) {
            this.url = url;
            this.id = id;
            this.name = name;
            this.on = on;
        }
    }

    static final class PairError extends Exception {
        PairError(String message) { super(message); }
    }

    private Computers() {}

    /** Asks one address. Null when nothing (or not nexttupp) answers there. */
    static Computer hello(String baseUrl, int connectMs) {
        try {
            JSONObject j = new JSONObject(request("GET", baseUrl + "/tv/hello", null, connectMs, 2000));
            if (!"nexttupp".equals(j.optString("app"))) return null;
            return new Computer(baseUrl, j.optString("id"), j.optString("name", "Computer"), j.optBoolean("on"));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Every nexttupp on this TV's subnet, the last-used address first (it's usually still right). Runs on the
     * caller's thread; call it off the main thread.
     */
    static List<Computer> find(Context context, String lastUrl) {
        Map<String, Computer> found = new LinkedHashMap<>();
        if (lastUrl != null) {
            Computer c = hello(lastUrl, 1500);
            if (c != null) found.put(c.id, c);
        }
        List<String> hosts = subnetHosts(context);
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        try {
            List<Callable<Computer>> jobs = new ArrayList<>();
            for (String host : hosts) {
                String url = "http://" + host + ":" + PORT;
                if (url.equals(lastUrl)) continue;
                jobs.add(() -> hello(url, 600));
            }
            for (Future<Computer> f : pool.invokeAll(jobs)) {
                Computer c = f.get();
                if (c != null && !found.containsKey(c.id)) found.put(c.id, c);
            }
        } catch (Exception ignored) {
            // Interrupted: return what was found.
        } finally {
            pool.shutdownNow();
        }
        List<Computer> list = new ArrayList<>(found.values());
        Collections.sort(list, (a, b) -> a.name.compareToIgnoreCase(b.name));
        return list;
    }

    /** "192.168.1.20" or "192.168.1.20:4546", as someone types it, to a base URL. */
    static String urlFor(String typed) {
        String t = typed.trim().replaceFirst("^https?://", "").replaceAll("/.*$", "");
        if (t.isEmpty()) return null;
        return "http://" + (t.contains(":") ? t : t + ":" + PORT);
    }

    /** Pairs with the code shown on the computer. Returns the cookie value the computer issued. */
    static String pair(Computer c, String code, String tvName) throws PairError {
        try {
            JSONObject body = new JSONObject().put("code", code).put("name", tvName);
            JSONObject j = new JSONObject(request("POST", c.url + "/tv/pair", body.toString(), 3000, 8000));
            String token = j.optString("token");
            if (token.isEmpty()) throw new PairError("The computer didn’t answer as expected. Try again.");
            return token;
        } catch (HttpError e) {
            throw new PairError(e.getMessage());
        } catch (PairError e) {
            throw e;
        } catch (Exception e) {
            throw new PairError("Can’t reach " + c.name + ". Check that nexttupp is open on it.");
        }
    }

    private static final class HttpError extends IOException {
        HttpError(String message) { super(message); }
    }

    private static String request(String method, String url, String json, int connectMs, int readMs) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(connectMs);
            conn.setReadTimeout(readMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "nexttupp-tv/" + version);
            if (json != null) {
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = conn.getOutputStream()) { out.write(bytes); }
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : read(in);
            if (status >= 400) {
                String message = "Something went wrong (" + status + "). Try again.";
                try { message = new JSONObject(text).optString("error", message); } catch (Exception ignored) {}
                throw new HttpError(message);
            }
            return text;
        } finally {
            conn.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = s.read(buf)) > 0 && out.size() < 65536) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    /** The other addresses on this TV's IPv4 network, at most the /24 around its own address. */
    private static List<String> subnetHosts(Context context) {
        List<String> hosts = new ArrayList<>();
        ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return hosts;
        Network network = cm.getActiveNetwork();
        LinkProperties lp = network == null ? null : cm.getLinkProperties(network);
        if (lp == null) return hosts;
        for (LinkAddress la : lp.getLinkAddresses()) {
            InetAddress a = la.getAddress();
            if (!(a instanceof Inet4Address) || a.isLoopbackAddress()) continue;
            byte[] b = a.getAddress();
            int self = ((b[0] & 0xff) << 24) | ((b[1] & 0xff) << 16) | ((b[2] & 0xff) << 8) | (b[3] & 0xff);
            int prefix = Math.max(24, Math.min(30, la.getPrefixLength()));
            int mask = prefix == 0 ? 0 : -1 << (32 - prefix);
            int net = self & mask;
            int size = 1 << (32 - prefix);
            for (int i = 1; i < size - 1; i++) {
                int ip = net + i;
                if (ip == self) continue;
                hosts.add(((ip >>> 24) & 0xff) + "." + ((ip >>> 16) & 0xff) + "." + ((ip >>> 8) & 0xff) + "." + (ip & 0xff));
            }
            break;
        }
        return hosts;
    }
}
