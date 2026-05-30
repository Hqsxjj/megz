package com.yg1215.megz;

import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "MegzPrefs";
    private static final String KEY_TARGET_URL = "targetUrl";
    private static final int FILECHOOSER_RESULTCODE = 1;
    private static final int REQUEST_CALL_PERMISSION = 2;
    private String pendingPhoneUrl;

    private WebView webView;
    private ProgressBar progressBar;
    private View offlineLayout;
    private View configLayout;
    private EditText editUrl;
    private Button btnSaveUrl;
    private Button btnRetry;

    private String targetUrl;
    private ValueCallback<Uri[]> uploadMessage;
    private long backPressedTime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // Bind layout views
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        offlineLayout = findViewById(R.id.offlineLayout);
        configLayout = findViewById(R.id.configLayout);
        editUrl = findViewById(R.id.editUrl);
        btnSaveUrl = findViewById(R.id.btnSaveUrl);
        btnRetry = findViewById(R.id.btnRetry);

        // Load targeted URL
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        targetUrl = prefs.getString(KEY_TARGET_URL, null);

        btnSaveUrl.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String inputUrl = editUrl.getText().toString().trim();
                if (inputUrl.isEmpty()) {
                    Toast.makeText(MainActivity.this, "请输入网址！", Toast.LENGTH_SHORT).show();
                    return;
                }
                
                // Prepend protocol if missing
                if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
                    inputUrl = "https://" + inputUrl;
                }

                // Persist URL
                SharedPreferences.Editor editor = prefs.edit();
                editor.putString(KEY_TARGET_URL, inputUrl);
                editor.apply();

                targetUrl = inputUrl;
                configLayout.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                
                initWebViewSettings();
                webView.loadUrl(targetUrl);
            }
        });

        btnRetry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                offlineLayout.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                webView.reload();
            }
        });

        // If URL not configured, show first launch config screen
        if (targetUrl == null || targetUrl.isEmpty()) {
            webView.setVisibility(View.GONE);
            configLayout.setVisibility(View.VISIBLE);
        } else {
            initWebViewSettings();
            webView.loadUrl(targetUrl);
        }
        
        // Add URL reset configuration feature on long pressing the app backdrop/WebView top
        findViewById(android.R.id.content).setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                showResetUrlDialog();
                return true;
            }
        });
    }

    private void initWebViewSettings() {
        WebSettings webSettings = webView.getSettings();
        
        // Enable highly premium, required capabilities for modern WebApps
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true); // Required for localStorage synchronization
        webSettings.setDatabaseEnabled(true);
        webSettings.setAllowFileAccess(true);
        webSettings.setAllowContentAccess(true);
        
        // Responsive Scaling viewport setup
        webSettings.setUseWideViewPort(true);
        webSettings.setLoadWithOverviewMode(true);
        webSettings.setBuiltInZoomControls(true);
        webSettings.setDisplayZoomControls(false); // Hide ugly browser zoom triggers
        
        // WebApp performance configurations
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Customize clients
        webView.setWebViewClient(new CustomWebViewClient());
        webView.setWebChromeClient(new CustomWebChromeClient());
    }

    private void showResetUrlDialog() {
        new AlertDialog.Builder(this)
                .setTitle("重置系统网址")
                .setMessage("确定要重置当前配置的系统服务网址吗？重置后可重新配置。")
                .setPositiveButton("重置", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                        SharedPreferences.Editor editor = prefs.edit();
                        editor.remove(KEY_TARGET_URL);
                        editor.apply();
                        
                        Toast.makeText(MainActivity.this, "配置已清空，请重新启动App或输入网址！", Toast.LENGTH_SHORT).show();
                        webView.setVisibility(View.GONE);
                        configLayout.setVisibility(View.VISIBLE);
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    // Custom WebViewClient to override navigation and handle tel: protocols
    private class CustomWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            return handleSpecialSchemes(url);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleSpecialSchemes(url);
        }

        private boolean handleSpecialSchemes(String url) {
            // Handle native dialing trigger
            if (url.startsWith("tel:")) {
                pendingPhoneUrl = url;
                if (androidx.core.content.ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.CALL_PHONE) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    placeDirectCall(url);
                } else {
                    androidx.core.app.ActivityCompat.requestPermissions(MainActivity.this, new String[]{android.Manifest.permission.CALL_PHONE}, REQUEST_CALL_PERMISSION);
                }
                return true;
            }
            // Handle native mail trigger
            if (url.startsWith("mailto:")) {
                try {
                    Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse(url));
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return true;
                }
            }
            // Handle native SMS trigger
            if (url.startsWith("sms:")) {
                try {
                    Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse(url));
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return true;
                }
            }
            // Standard web URL loading
            return false;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            progressBar.setVisibility(View.VISIBLE);
            progressBar.setProgress(0);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progressBar.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // Only trigger offline layout on main page failures, to avoid breaking minor sub-frames
            if (request.isForMainFrame()) {
                webView.setVisibility(View.GONE);
                offlineLayout.setVisibility(View.VISIBLE);
            }
        }
    }

    // Custom WebChromeClient to enable file uploads and native dialog alerts
    private class CustomWebChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progressBar.setProgress(newProgress);
            if (newProgress == 100) {
                progressBar.setVisibility(View.GONE);
            } else {
                progressBar.setVisibility(View.VISIBLE);
            }
        }

        // Intercept file chooser to select local sheets/contacts
        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
            if (uploadMessage != null) {
                uploadMessage.onReceiveValue(null);
                uploadMessage = null;
            }

            uploadMessage = filePathCallback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*"); // Set to wildcards or xls/vcf specific mime-types

            try {
                startActivityForResult(Intent.createChooser(intent, "选择导入的表格或文件"), FILECHOOSER_RESULTCODE);
            } catch (Exception e) {
                uploadMessage = null;
                Toast.makeText(MainActivity.this, "未能唤起文件管理器", Toast.LENGTH_SHORT).show();
                return false;
            }
            return true;
        }

        // Override default alerts to native Material Design Dialogs
        @Override
        public boolean onJsAlert(WebView view, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("系统提示")
                    .setMessage(message)
                    .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("系统确认")
                    .setMessage(message)
                    .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.confirm();
                        }
                    })
                    .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            result.cancel();
                        }
                    })
                    .setCancelable(false)
                    .show();
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILECHOOSER_RESULTCODE) {
            if (uploadMessage == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) {
                    results = new Uri[]{Uri.parse(dataString)};
                }
            }
            uploadMessage.onReceiveValue(results);
            uploadMessage = null;
        }
    }

    private void placeDirectCall(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse(url));
            startActivity(intent);
        } catch (SecurityException e) {
            fallbackToDial(url);
        } catch (Exception e) {
            fallbackToDial(url);
        }
    }

    private void fallbackToDial(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_DIAL, Uri.parse(url));
            startActivity(intent);
        } catch (Exception ex) {
            Toast.makeText(MainActivity.this, "无法启动拨号组件", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CALL_PERMISSION) {
            if (grantResults.length > 0 && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                if (pendingPhoneUrl != null) {
                    placeDirectCall(pendingPhoneUrl);
                }
            } else {
                Toast.makeText(this, "未授予直接通话权限，已切换为系统拨号盘", Toast.LENGTH_SHORT).show();
                if (pendingPhoneUrl != null) {
                    fallbackToDial(pendingPhoneUrl);
                }
            }
            pendingPhoneUrl = null;
        }
    }

    // Intercept hardware Back press key to implement in-app history backtracking
    @Override
    public void onBackPressed() {
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else {
            // Double click back to exit app safety mechanism
            if (System.currentTimeMillis() - backPressedTime < 2000) {
                super.onBackPressed();
            } else {
                Toast.makeText(this, "再按一次退出 每日工作", Toast.LENGTH_SHORT).show();
                backPressedTime = System.currentTimeMillis();
            }
        }
    }
}
