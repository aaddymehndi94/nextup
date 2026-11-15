import { Check, Plus } from 'lucide-react'
import { useDocumentTitle } from '../hooks.ts'
import { useProfiles } from '../profiles.ts'
import { ACCENTS, accentColor, BACKGROUNDS, CORNERS, DEFAULT_THEME, PRESETS, presetOf, setTheme, TEXT_SIZES, useTheme } from '../theme.ts'
import { TopBar } from '../components/TopBar.tsx'

// Appearance: a preset look, or your own: the colour of buttons and highlights, the background, text size,
// poster corners, motion and the title-page tint. Every change shows at once, on this page too.

export function Appearance () {
  useDocumentTitle('Appearance')
  const t = useTheme()
  const profiles = useProfiles()
  const who = profiles.status === 'ready' ? profiles.active?.name : undefined
  const preset = presetOf(t)
  const own = t.accent === 'custom'

  return (
    <main className="account-page appearance-page">
      <TopBar solid />
      <div className="account-body appearance-body">
        <header className="account-head">
          <h1 className="account-title">Appearance</h1>
          <p className="account-lede">Make nexttupp look the way you like{who ? `, ${who}` : ''}. It’s saved for this profile on this device, and every change shows straight away.</p>
        </header>

        <section className="account-section" aria-labelledby="look-presets">
          <h2 id="look-presets" className="section-title">Themes</h2>
          <div className="theme-presets" role="group" aria-labelledby="look-presets">
            {PRESETS.map(p => {
              const bg = BACKGROUNDS.find(b => b.id === p.background)!.shades
              const accent = ACCENTS.find(a => a.id === p.accent)!.color
              const on = preset?.id === p.id
              return (
                <button key={p.id} type="button" aria-pressed={on} className="theme-preset" onClick={() => setTheme({ accent: p.accent, background: p.background })}>
                  <span className="theme-preset-art" style={{ background: bg[0] }} aria-hidden>
                    <span className="theme-preset-card" style={{ background: bg[2] }} />
                    <span className="theme-preset-card" style={{ background: bg[2] }} />
                    <span className="theme-preset-pill" style={{ background: accent }} />
                  </span>
                  <span className="theme-preset-name">{p.label}{on && <Check aria-hidden />}</span>
                </button>
              )
            })}
          </div>
          {!preset && <p className="account-note">Your own mix. Pick a theme to start again from one.</p>}
        </section>

        <section className="account-section" aria-labelledby="look-colour">
          <h2 id="look-colour" className="section-title">Colour</h2>
          <p className="switch-label" id="look-accent">Buttons and highlights</p>
          <div className="theme-swatches" role="group" aria-labelledby="look-accent">
            {ACCENTS.map(a => (
              <button key={a.id} type="button" aria-pressed={t.accent === a.id} aria-label={a.label} data-tip={a.label}
                className="theme-swatch" style={{ background: a.color }} onClick={() => setTheme({ accent: a.id })}>
                {t.accent === a.id && <Check aria-hidden />}
              </button>
            ))}
            <label className={`theme-swatch theme-swatch-custom${own ? ' is-on' : ''}`} data-tip="Your own colour" style={own ? { background: accentColor(t) } : undefined}>
              <input type="color" className="theme-colour-input" value={t.custom} aria-label="Your own colour"
                onChange={e => setTheme({ accent: 'custom', custom: e.target.value })} />
              {own ? <Check aria-hidden /> : <Plus aria-hidden />}
            </label>
          </div>
          {own && accentColor(t) !== t.custom && <p className="account-note">Lightened a little, so the text on it stays readable.</p>}
          <p className="switch-label" id="look-bg">Background</p>
          <div className="theme-swatches" role="group" aria-labelledby="look-bg">
            {BACKGROUNDS.map(b => (
              <button key={b.id} type="button" aria-pressed={t.background === b.id} aria-label={b.label} data-tip={b.label}
                className="theme-swatch theme-swatch-dark" style={{ background: `linear-gradient(135deg, ${b.shades[0]} 50%, ${b.shades[2]} 50%)` }} onClick={() => setTheme({ background: b.id })}>
                {t.background === b.id && <Check aria-hidden />}
              </button>
            ))}
          </div>
          <div className="theme-sample" aria-hidden>
            <span className="button primary">Play</span>
            <span className="chip active">Films</span>
            <span className="meter"><span style={{ width: '62%' }} /></span>
          </div>
        </section>

        <section className="account-section" aria-labelledby="look-text">
          <h2 id="look-text" className="section-title">Text and shapes</h2>
          <p className="switch-label" id="look-size">Text size</p>
          <div className="chips" role="group" aria-labelledby="look-size">
            {TEXT_SIZES.map(s => (
              <button key={s.id} type="button" aria-pressed={t.text === s.id} className={`chip${t.text === s.id ? ' active' : ''}`} onClick={() => setTheme({ text: s.id })}>{s.label}</button>
            ))}
          </div>
          <p className="switch-label" id="look-corners">Poster corners</p>
          <div className="chips" role="group" aria-labelledby="look-corners">
            {CORNERS.map(c => (
              <button key={c.id} type="button" aria-pressed={t.corners === c.id} className={`chip${t.corners === c.id ? ' active' : ''}`} onClick={() => setTheme({ corners: c.id })}>{c.label}</button>
            ))}
          </div>
        </section>

        <section className="account-section" aria-labelledby="look-motion">
          <h2 id="look-motion" className="section-title">Motion and colour from artwork</h2>
          <label className="switch-row">
            <span className="switch-text">
              <span className="switch-label">Calm motion</span>
              <span className="account-note">Pages, menus and cards appear without sliding or fading.</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={t.calm} onChange={e => setTheme({ calm: e.target.checked })} />
          </label>
          <label className="switch-row">
            <span className="switch-text">
              <span className="switch-label">Tint title pages</span>
              <span className="account-note">A title’s page takes on the colour of its artwork.</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={t.ambient} onChange={e => setTheme({ ambient: e.target.checked })} />
          </label>
        </section>

        <section className="account-section">
          <button type="button" className="button secondary" disabled={JSON.stringify(t) === JSON.stringify(DEFAULT_THEME)} onClick={() => setTheme(DEFAULT_THEME)}>
            Back to the default look
          </button>
        </section>
      </div>
    </main>
  )
}
