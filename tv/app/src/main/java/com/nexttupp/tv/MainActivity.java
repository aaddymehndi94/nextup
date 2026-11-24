package com.nexttupp.tv;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SoundEffectConstants;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole TV app: find nexttupp on the home network, pair once with the code from the computer's
 * "Add a TV", then show nexttupp full screen in a WebView. The computer does the searching, torrenting and
 * converting; the TV's WebView plays the video and the remote's arrow keys move focus.
 */
public final class MainActivity extends Activity {
    private static final String COOKIE = "nexttupp_lan";

    // DESIGN.md: Projection Black, Screen White, Silver, Ink on Light.
    private static final int BLACK = 0xff0a0a0b;
    private static final int WHITE = 0xfff5f5f7;
    private static final int SILVER = 0xffb4b4bb;
    private static final int INK = 0xff0a0a0b;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    /** Bumped on every screen change, so late answers from the network for an old screen are dropped. */
    private int screen;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            Computers.version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {}
        prefs = getSharedPreferences("nexttupp", MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(BLACK);
        setContentView(root);
        if (prefs.getString("token", null) != null && prefs.getString("url", null) != null) openWeb();
        else search();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---- Setup screens --------------------------------------------------------------------------------

    private void search() {
        int s = show("Looking for nexttupp on your Wi-Fi…", null, spinner());
        String last = prefs.getString("url", null);
        io.execute(() -> {
            List<Computers.Computer> found = Computers.find(this, last);
            main.post(() -> { if (s == screen) onFound(found); });
        });
    }

    private void onFound(List<Computers.Computer> found) {
        String savedId = prefs.getString("id", null);
        // Paired before and its address changed: go straight back to it.
        if (savedId != null && prefs.getString("token", null) != null) {
            for (Computers.Computer c : found) {
                if (c.id.equals(savedId)) { save(c, prefs.getString("token", null)); openWeb(); return; }
            }
        }
        if (found.isEmpty()) {
            show("Can’t find nexttupp on this Wi-Fi.",
                "Open nexttupp on your computer. It has to be on the same Wi-Fi as this TV.",
                button("Try again", v -> search()), button("Type the computer’s address", v -> typeAddress(null)));
        } else if (found.size() == 1) {
            choose(found.get(0));
        } else {
            View[] buttons = new View[found.size()];
            for (int i = 0; i < found.size(); i++) {
                Computers.Computer c = found.get(i);
                buttons[i] = button(c.name, v -> choose(c));
            }
            show("Pick your computer.", null, buttons);
        }
    }

    private void choose(Computers.Computer c) {
        if (!c.on) {
            show("Turn on phones and TVs on " + c.name + ".",
                "In nexttupp on the computer, sign in, open Account, and turn on “Let phones play from this computer”.",
                button("Try again", v -> search()));
            return;
        }
        askCode(c, null);
    }

    private void typeAddress(String error) {
        EditText field = field("192.168.1.20", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, 40);
        Runnable go = () -> {
            String url = Computers.urlFor(field.getText().toString());
            if (url == null) return;
            int s = show("Looking at " + field.getText().toString().trim() + "…", null, spinner());
            io.execute(() -> {
                Computers.Computer c = Computers.hello(url, 3000);
                main.post(() -> {
                    if (s != screen) return;
                    if (c == null) typeAddress("nexttupp didn’t answer there. Check the address on the computer, under Account.");
                    else choose(c);
                });
            });
        };
        field.setOnEditorActionListener((v, action, e) -> { go.run(); return true; });
        show("Type the computer’s address.",
            "On the computer, nexttupp shows it under Account, like 192.168.1.20.",
            field, error == null ? null : note(error), button("Connect", v -> go.run()), button("Look again", v -> search()));
        field.requestFocus();
    }

    private void askCode(Computers.Computer c, String error) {
        EditText field = field("0000", InputType.TYPE_CLASS_NUMBER, 4);
        field.setLetterSpacing(0.3f);
        field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 40);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        Runnable go = () -> {
            String code = field.getText().toString();
            if (code.length() == 4) pairWith(c, code);
        };
        field.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int b, int n) {}
            public void onTextChanged(CharSequence s, int a, int b, int n) {}
            public void afterTextChanged(Editable e) { if (e.length() == 4) go.run(); }
        });
        field.setOnEditorActionListener((v, action, e) -> { go.run(); return true; });
        show("Type the code from " + c.name + ".",
            "On the computer, open nexttupp, go to Account, and choose Add a TV.",
            field, error == null ? null : note(error), button("Connect", v -> go.run()), button("Pick another computer", v -> search()));
        field.requestFocus();
    }

    private void pairWith(Computers.Computer c, String code) {
        int s = show("Connecting to " + c.name + "…", null, spinner());
        io.execute(() -> {
            try {
                String token = Computers.pair(c, code, tvName());
                main.post(() -> { if (s == screen) { save(c, token); openWeb(); } });
            } catch (Computers.PairError e) {
                main.post(() -> { if (s == screen) askCode(c, e.getMessage()); });
            }
        });
    }

    private void save(Computers.Computer c, String token) {
        prefs.edit().putString("url", c.url).putString("id", c.id).putString("name", c.name).putString("token", token).apply();
    }

    private String tvName() {
        String name = null;
        if (Build.VERSION.SDK_INT >= 25) name = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME);
        if (name == null || name.trim().isEmpty()) name = Build.MODEL;
        return name == null || name.trim().isEmpty() ? "TV" : name.trim();
    }

    // ---- nexttupp itself ------------------------------------------------------------------------------

    private void openWeb() {
        String url = prefs.getString("url", null);
        String token = prefs.getString("token", null);
        String name = prefs.getString("name", "the computer");
        screen++;
        if (web == null) web = makeWebView();
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(url, COOKIE + "=" + token + "; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax");
        cookies.flush();
        web.setTag(name);
        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(url + "/");
        web.requestFocus();
    }

    /** Set by the page while a text field has focus without its keyboard (web/src/tvnav.ts). */
    private volatile boolean textWaiting;

    /**
     * OK on a text field. The TV's keyboard app gets keys before the page whenever a field has focus, and while
     * it's hidden it swallows OK, so the page never hears it. Take OK first and have the page open the keyboard.
     */
    private boolean okOnTextField(WebView w, KeyEvent event) {
        int k = event.getKeyCode();
        if (k != KeyEvent.KEYCODE_DPAD_CENTER && k != KeyEvent.KEYCODE_ENTER && k != KeyEvent.KEYCODE_NUMPAD_ENTER) return false;
        if (!w.onCheckIsTextEditor() && !textWaiting) return false;
        boolean hidden = Build.VERSION.SDK_INT >= 30 ? !imeShowing(w) : textWaiting;
        if (!hidden && !textWaiting) return false;
        if (event.getAction() == KeyEvent.ACTION_UP) {
            w.playSoundEffect(SoundEffectConstants.CLICK);
            w.evaluateJavascript("window.__nexttuppTvOpenKeyboard && window.__nexttuppTvOpenKeyboard()", null);
        }
        return true;
    }

    private static boolean imeShowing(View v) {
        if (Build.VERSION.SDK_INT < 30) return false;
        WindowInsets insets = v.getRootWindowInsets();
        return insets != null && insets.isVisible(WindowInsets.Type.ime());
    }

    private WebView makeWebView() {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        WebView w = new WebView(this) {
            @Override
            public boolean dispatchKeyEventPreIme(KeyEvent event) {
                return okOnTextField(this, event) || super.dispatchKeyEventPreIme(event);
            }
        };
        w.setBackgroundColor(BLACK);
        WebSettings ws = w.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setUserAgentString(ws.getUserAgentString() + " nexttupp-tv/" + Computers.version);
        w.addJavascriptInterface(new Bridge(), "NexttuppTV");
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Only the computer's own pages: there's no browser to hand other links to on most TVs.
                Uri base = Uri.parse(prefs.getString("url", ""));
                Uri to = request.getUrl();
                return !(base.getHost() != null && base.getHost().equals(to.getHost()) && base.getPort() == to.getPort());
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) main.post(() -> unreachable());
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                // The computer no longer knows this TV (removed under Account, or its data was reset).
                if (request.isForMainFrame() && response.getStatusCode() == 401) main.post(() -> removed());
            }
        });
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }

            @Override
            public void onHideCustomView() { leaveFullscreen(); }
        });
        return w;
    }

    private void leaveFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    private void unreachable() {
        String name = prefs.getString("name", "the computer");
        show("Can’t reach " + name + ".",
            "Check that the computer is on and nexttupp is open on it, on the same Wi-Fi as this TV.",
            button("Try again", v -> search()), button("Pick another computer", v -> { forget(); search(); }));
    }

    private void removed() {
        String url = prefs.getString("url", null);
        String id = prefs.getString("id", null);
        String name = prefs.getString("name", "the computer");
        prefs.edit().remove("token").apply();
        Computers.Computer c = new Computers.Computer(url, id, name, true);
        askCode(c, "This TV isn’t connected to " + name + " any more. Type a new code to connect again.");
    }

    private void forget() {
        prefs.edit().clear().apply();
        CookieManager.getInstance().removeAllCookies(null);
    }

    /** window.NexttuppTV in the page (web/src/tv.ts). */
    private final class Bridge {
        @JavascriptInterface
        public void keepAwake(boolean on) {
            main.post(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public String version() { return Computers.version; }

        /** The TV's own navigation sound for a move or OK in the page (web/src/tvnav.ts); the TV's setting applies. */
        @JavascriptInterface
        public void sound(String kind) {
            final int fx;
            switch (kind == null ? "" : kind) {
                case "up": fx = SoundEffectConstants.NAVIGATION_UP; break;
                case "down": fx = SoundEffectConstants.NAVIGATION_DOWN; break;
                case "left": fx = SoundEffectConstants.NAVIGATION_LEFT; break;
                case "right": fx = SoundEffectConstants.NAVIGATION_RIGHT; break;
                default: fx = SoundEffectConstants.CLICK;
            }
            main.post(() -> { if (web != null) web.playSoundEffect(fx); });
        }

        /** A text field has focus with its keyboard held back (true), or not any more (false). */
        @JavascriptInterface
        public void textField(boolean waiting) { textWaiting = waiting; }

        /** OK on a text field: the page has given it its keyboard back (web/src/tvnav.ts). */
        @JavascriptInterface
        public void showKeyboard() {
            main.post(() -> {
                InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null && web != null) imm.showSoftInput(web, 0);
            });
        }
    }

    /** Back: the page closes what's open first (window.__nexttuppTvBack), then back a page, then out of the app. */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.getParent() != null) {
            if (fullscreenView != null) { leaveFullscreen(); return true; }
            web.evaluateJavascript("window.__nexttuppTvBack ? window.__nexttuppTvBack() : false", handled -> {
                if ("true".equals(handled)) return;
                if (web.canGoBack()) web.goBack();
                else finish();
            });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---- Views ----------------------------------------------------------------------------------------

    /** One screen: a title, an optional line under it, then its controls. Returns the screen's number. */
    private int show(String title, String body, View... controls) {
        screen++;
        if (web != null) web.stopLoading();
        leaveFullscreen();
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_VERTICAL);
        // TV-safe margins: 48dp at the sides, 27dp top and bottom (Android TV guidelines), plus breathing room.
        col.setPadding(dp(96), dp(54), dp(96), dp(54));

        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.wordmark);
        mark.setAdjustViewBounds(true);
        LinearLayout.LayoutParams markLp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(28));
        markLp.bottomMargin = dp(48);
        col.addView(mark, markLp);

        TextView t = text(title, 34, WHITE, true);
        col.addView(t, wrap(0, dp(12)));
        if (body != null) col.addView(text(body, 20, SILVER, false), wrap(0, dp(8)));

        LinearLayout row = null;
        for (View c : controls) {
            if (c == null) continue;
            if (c instanceof Button) {
                if (row == null) {
                    row = new LinearLayout(this);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    col.addView(row, wrap(dp(28), 0));
                }
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(56));
                lp.rightMargin = dp(16);
                row.addView(c, lp);
            } else {
                row = null;
                col.addView(c, wrap(dp(24), 0));
            }
        }
        root.removeAllViews();
        root.addView(col, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Focus the first button, so OK on the remote does the obvious thing.
        for (View c : controls) if (c instanceof Button) { c.requestFocus(); break; }
        return screen;
    }

    private LinearLayout.LayoutParams wrap(int top, int bottom) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = top;
        lp.bottomMargin = bottom;
        return lp;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(Typeface.create("sans-serif", bold ? Typeface.BOLD : Typeface.NORMAL));
        t.setMaxWidth(dp(760));
        t.setLineSpacing(0, 1.2f);
        return t;
    }

    private TextView note(String s) {
        TextView t = text(s, 20, WHITE, true);
        t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private ProgressBar spinner() {
        ProgressBar p = new ProgressBar(this);
        p.setIndeterminateTintList(ColorStateList.valueOf(WHITE));
        p.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        return p;
    }

    /** A pill: 14% white at rest; focused (the remote is on it), solid white with dark text. */
    private Button button(String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        b.setPadding(dp(28), 0, dp(28), 0);
        b.setStateListAnimator(null);
        b.setFocusable(true);
        StateListDrawable bg = new StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, pill(Color.WHITE, 0));
        bg.addState(new int[]{android.R.attr.state_pressed}, pill(Color.WHITE, 0));
        bg.addState(new int[]{}, pill(0x24ffffff, 0));
        b.setBackground(bg);
        b.setTextColor(new ColorStateList(
            new int[][]{{android.R.attr.state_focused}, {android.R.attr.state_pressed}, {}},
            new int[]{INK, INK, WHITE}));
        b.setOnClickListener(onClick);
        return b;
    }

    private EditText field(String hint, int inputType, int max) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(0x66ffffff);
        e.setTextColor(WHITE);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        e.setInputType(inputType);
        e.setSingleLine(true);
        e.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)});
        e.setMinWidth(dp(320));
        e.setPadding(dp(24), dp(12), dp(24), dp(12));
        StateListDrawable bg = new StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, pill(0x1affffff, Color.WHITE));
        bg.addState(new int[]{}, pill(0x1affffff, 0x29ffffff));
        e.setBackground(bg);
        return e;
    }

    private Drawable pill(int fill, int stroke) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(999));
        if (stroke != 0) d.setStroke(dp(3), stroke);
        return d;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

}
