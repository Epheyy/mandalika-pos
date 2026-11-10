package com.mandalika.pos;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

/**
 * Immersive POS shell: the app draws edge-to-edge with the status and
 * navigation bars hidden, so it uses the full screen. A swipe from the top
 * or bottom edge reveals the bars transiently, then they auto-hide and the
 * app returns to fullscreen (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE).
 *
 * The web layer pads with the CSS vars --sat/--sab/--sal/--sar (with
 * env(safe-area-inset-*) as a fallback). Those vars are fed from the REAL
 * Android insets below — env(safe-area-inset-*) is unreliable for Android
 * system bars, so we inject the authoritative values ourselves. With the bars
 * hidden the system-bar insets are 0 (the app expands); the display cutout
 * (notch) is always reported, so content is never clipped by a notch.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must precede super.onCreate: the bridge loads plugins during it.
        registerPlugin(OutboxJournalPlugin.class);
        registerPlugin(ClassicPrinterPlugin.class);
        super.onCreate(savedInstanceState);
        pinTextZoom();
        applyImmersive();
        installInsetBridge();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /**
     * Pin WebView text zoom to 100%. By default WebSettings.textZoom follows
     * the system font scale, so Settings > Display > Font size at max (2.0)
     * multiplied every CSS px and clipped the cart, the Bayar amount and the
     * quick-amount buttons (R11 tablet run, SM-X115). The app's own SM/MD/LG
     * font-size setting is the size control, so the system scale is ignored.
     */
    private void pinTextZoom() {
        if (getBridge() == null) return;
        final WebView web = getBridge().getWebView();
        if (web == null) return;
        web.getSettings().setTextZoom(100);
    }

    private void applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(
                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    private void installInsetBridge() {
        final View root = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            float density = getResources().getDisplayMetrics().density;
            int top = Math.round(bars.top / density);
            int bottom = Math.round(bars.bottom / density);
            int left = Math.round(bars.left / density);
            int right = Math.round(bars.right / density);
            pushInsets(top, bottom, left, right);
            return insets;
        });
    }

    private void pushInsets(int top, int bottom, int left, int right) {
        if (getBridge() == null) return;
        final WebView web = getBridge().getWebView();
        if (web == null) return;
        final String js =
                "(function(){var s=document.documentElement.style;"
                        + "s.setProperty('--sat','" + top + "px');"
                        + "s.setProperty('--sab','" + bottom + "px');"
                        + "s.setProperty('--sal','" + left + "px');"
                        + "s.setProperty('--sar','" + right + "px');})();";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
