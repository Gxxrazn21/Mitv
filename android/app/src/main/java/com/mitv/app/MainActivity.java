package com.mitv.app;

import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Safe area & Cutout mode for edge-to-edge support with display notches / punch-holes
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        // Dark navigation/status bar to match MiTV theme
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(0xFF0F1015);
            getWindow().setNavigationBarColor(0xFF070709);
        }

        // Intercept Android Back navigation (Mobile gesture & Back button)
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleBackAction();
            }
        });
    }

    private void handleBackAction() {
        if (bridge == null || bridge.getWebView() == null) {
            finish();
            return;
        }

        final WebView webView = bridge.getWebView();
        // Check if player or document is currently in fullscreen
        String checkFullscreenJs =
            "(function() {" +
            "  var isFull = !!(document.fullscreenElement || document.documentElement.classList.contains('is-fullscreen') || document.querySelector('.stream-slot.is-fullscreen'));" +
            "  if (isFull) {" +
            "    if (document.exitFullscreen) { document.exitFullscreen().catch(function(){}); }" +
            "    document.documentElement.classList.remove('is-fullscreen');" +
            "    var btn = document.getElementById('fullscreenBtn');" +
            "    if (btn) {" +
            "      var sp = btn.querySelector('span');" +
            "      if (sp) sp.textContent = 'Pantalla Completa';" +
            "    }" +
            "    return 'EXITED_FULLSCREEN';" +
            "  }" +
            "  return 'NOT_FULLSCREEN';" +
            "})();";

        webView.evaluateJavascript(checkFullscreenJs, value -> {
            if (value != null && value.contains("EXITED_FULLSCREEN")) {
                // Successfully exited fullscreen, keep the app active!
                return;
            }
            // If modal is open, let JS close it
            String closeModalJs =
                "(function() {" +
                "  var modal = document.getElementById('phoneModal');" +
                "  if (modal && modal.style.display !== 'none') {" +
                "    var closeBtn = document.getElementById('closePhoneModalBtn');" +
                "    if (closeBtn) { closeBtn.click(); return 'MODAL_CLOSED'; }" +
                "  }" +
                "  return 'NO_MODAL';" +
                "})();";

            webView.evaluateJavascript(closeModalJs, modalVal -> {
                if (modalVal != null && modalVal.contains("MODAL_CLOSED")) {
                    return;
                }
                // If webview has navigation history, go back; otherwise finish activity
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
            });
        });
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Intercept hardware / remote KEYCODE_BACK specifically on ACTION_DOWN for Android TV / Fire TV
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_DOWN) {
            handleBackAction();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
