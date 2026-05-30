package com.yg1215.megz;

import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.provider.CallLog;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
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
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;

import java.util.List;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "MegzPrefs";
    private static final String KEY_TARGET_URL = "targetUrl";
    private static final String KEY_DUAL_SIM = "dualSimEnabled";
    private static final String KEY_ROTATION_INTERVAL = "rotationInterval";
    private static final String KEY_DIAL_COUNT = "dialCount";

    private static final int FILECHOOSER_RESULTCODE = 1;
    private static final int REQUEST_CALL_PERMISSION = 2;

    private WebView webView;
    private ProgressBar progressBar;
    private View offlineLayout;
    private View configLayout;
    private EditText editUrl;
    private SwitchCompat switchDualSim;
    private RadioGroup radioGroupInterval;
    private RadioButton radio5;
    private RadioButton radio10;
    private Button btnSaveUrl;
    private Button btnRetry;

    private String targetUrl;
    private boolean dualSimEnabled;
    private int rotationInterval;
    private int dialCount;

    private ValueCallback<Uri[]> uploadMessage;
    private String pendingPhoneUrl;
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
        switchDualSim = findViewById(R.id.switchDualSim);
        radioGroupInterval = findViewById(R.id.radioGroupInterval);
        radio5 = findViewById(R.id.radio5);
        radio10 = findViewById(R.id.radio10);
        btnSaveUrl = findViewById(R.id.btnSaveUrl);
        btnRetry = findViewById(R.id.btnRetry);

        // Load targeted configurations
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        targetUrl = prefs.getString(KEY_TARGET_URL, null);
        dualSimEnabled = prefs.getBoolean(KEY_DUAL_SIM, true);
        rotationInterval = prefs.getInt(KEY_ROTATION_INTERVAL, 5);
        dialCount = prefs.getInt(KEY_DIAL_COUNT, 0);

        // Populate config UI values
        switchDualSim.setChecked(dualSimEnabled);
        if (rotationInterval == 10) {
            radio10.setChecked(true);
        } else {
            radio5.setChecked(true);
        }

        switchDualSim.setOnCheckedChangeListener((buttonView, isChecked) -> {
            findViewById(R.id.layoutInterval).setVisibility(isChecked ? View.VISIBLE : View.GONE);
        });
        findViewById(R.id.layoutInterval).setVisibility(dualSimEnabled ? View.VISIBLE : View.GONE);

        btnSaveUrl.setOnClickListener(v -> {
            String inputUrl = editUrl.getText().toString().trim();
            if (inputUrl.isEmpty()) {
                Toast.makeText(MainActivity.this, "请输入网址！", Toast.LENGTH_SHORT).show();
                return;
            }
            
            // Prepend protocol if missing
            if (!inputUrl.startsWith("http://") && !inputUrl.startsWith("https://")) {
                inputUrl = "https://" + inputUrl;
            }

            boolean isDualSimChecked = switchDualSim.isChecked();
            int selectedInterval = radio10.isChecked() ? 10 : 5;

            // Persist configurations
            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(KEY_TARGET_URL, inputUrl);
            editor.putBoolean(KEY_DUAL_SIM, isDualSimChecked);
            editor.putInt(KEY_ROTATION_INTERVAL, selectedInterval);
            editor.apply();

            targetUrl = inputUrl;
            dualSimEnabled = isDualSimChecked;
            rotationInterval = selectedInterval;

            configLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            
            initWebViewSettings();
            webView.loadUrl(targetUrl);
        });

        btnRetry.setOnClickListener(v -> {
            offlineLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.reload();
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
        findViewById(android.R.id.content).setOnLongClickListener(v -> {
            showResetUrlDialog();
            return true;
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
                .setMessage("确定要重置当前配置的系统服务与拨号轮换设置吗？重置后可重新配置。")
                .setPositiveButton("重置", (dialog, which) -> {
                    SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                    SharedPreferences.Editor editor = prefs.edit();
                    editor.remove(KEY_TARGET_URL);
                    editor.remove(KEY_DUAL_SIM);
                    editor.remove(KEY_ROTATION_INTERVAL);
                    editor.remove(KEY_DIAL_COUNT);
                    editor.apply();
                    
                    Toast.makeText(MainActivity.this, "配置已清空，请重新启动App或输入网址！", Toast.LENGTH_SHORT).show();
                    webView.setVisibility(View.GONE);
                    configLayout.setVisibility(View.VISIBLE);
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
                
                // Request dynamic permissions for Direct Call and Call Logs simultaneously
                if (androidx.core.content.ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.CALL_PHONE) == android.content.pm.PERMISSION_GRANTED &&
                    androidx.core.content.ContextCompat.checkSelfPermission(MainActivity.this, android.Manifest.permission.READ_CALL_LOG) == android.content.pm.PERMISSION_GRANTED) {
                    placeDirectCall(url);
                } else {
                    androidx.core.app.ActivityCompat.requestPermissions(MainActivity.this, new String[]{
                        android.Manifest.permission.CALL_PHONE,
                        android.Manifest.permission.READ_CALL_LOG
                    }, REQUEST_CALL_PERMISSION);
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
                    .setPositiveButton("确定", (dialog, which) -> result.confirm())
                    .setCancelable(false)
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, final android.webkit.JsResult result) {
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle("系统确认")
                    .setMessage(message)
                    .setPositiveButton("确定", (dialog, which) -> result.confirm())
                    .setNegativeButton("取消", (dialog, which) -> result.cancel())
                    .setCancelable(false)
                    .show();
            return true;
        }
    }

    private void placeDirectCall(String url) {
        try {
            Intent intent = new Intent(Intent.ACTION_CALL, Uri.parse(url));
            
            // Advanced Dual-SIM Programmatic Rotation Extra Handling
            if (dualSimEnabled) {
                TelecomManager telecomManager = (TelecomManager) getSystemService(Context.TELECOM_SERVICE);
                if (telecomManager != null) {
                    try {
                        List<PhoneAccountHandle> phoneAccounts = telecomManager.getCallCapablePhoneAccounts();
                        if (phoneAccounts != null && phoneAccounts.size() >= 2) {
                            // Increment dialCount persisted counter
                            dialCount++;
                            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                            SharedPreferences.Editor editor = prefs.edit();
                            editor.putInt(KEY_DIAL_COUNT, dialCount);
                            editor.apply();

                            // Calculate which SIM slot to place the call: 0 (SIM1) or 1 (SIM2)
                            int targetSlot = (dialCount / rotationInterval) % phoneAccounts.size();
                            PhoneAccountHandle targetHandle = phoneAccounts.get(targetSlot);
                            
                            // Attach PhoneAccountHandle extra to instruct system to call from targeted SIM
                            intent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, targetHandle);
                            
                            // Highly premium cross-manufacturer compatible extras
                            intent.putExtra("com.android.phone.extra.slot", targetSlot);
                            intent.putExtra("phone", targetSlot);
                            intent.putExtra("subscription", targetSlot);
                            intent.putExtra("simSlot", targetSlot);
                            intent.putExtra("slot", targetSlot);
                            
                            Toast.makeText(this, "智能双卡轮拨：正在使用卡 " + (targetSlot + 1) + " 拨出...", Toast.LENGTH_SHORT).show();
                        }
                    } catch (SecurityException se) {
                        se.printStackTrace();
                    }
                }
            }
            
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
    protected void onResume() {
        super.onResume();
        
        // Automated Outgoing Call Duration query injection
        if (pendingPhoneUrl != null) {
            String phoneNumber = pendingPhoneUrl.replace("tel:", "").trim();
            pendingPhoneUrl = null; // Clear pending call immediately to avoid double execution on reload
            
            // Query latest Outgoing Call duration in a small background handler or simple query
            int duration = getLastOutgoingCallDuration(phoneNumber);
            if (duration >= 0) {
                // Smoothly inject call duration directly back to the WebView's JS callback!
                String js = "if (typeof onAndroidCallResult === 'function') { onAndroidCallResult(" + duration + "); }";
                webView.evaluateJavascript(js, null);
                Toast.makeText(this, "已自动获取通话记录，通话时长：" + duration + "秒", Toast.LENGTH_LONG).show();
            }
        }
    }

    private int getLastOutgoingCallDuration(String phoneNumber) {
        if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_CALL_LOG) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return -1;
        }

        // Standardize clean number for strict cross-matching
        String cleanNumber = phoneNumber.replaceAll("[^\\d+]", "");
        if (cleanNumber.isEmpty()) return -1;

        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(
                    CallLog.Calls.CONTENT_URI,
                    new String[]{CallLog.Calls.DURATION, CallLog.Calls.NUMBER, CallLog.Calls.DATE},
                    CallLog.Calls.TYPE + " = ?",
                    new String[]{String.valueOf(CallLog.Calls.OUTGOING_TYPE)},
                    CallLog.Calls.DATE + " DESC"
            );

            if (cursor != null && cursor.moveToFirst()) {
                long currentTime = System.currentTimeMillis();
                do {
                    String number = cursor.getString(cursor.getColumnIndex(CallLog.Calls.NUMBER));
                    long date = cursor.getLong(cursor.getColumnIndex(CallLog.Calls.DATE));
                    
                    // Match the latest placed outgoing number (only match calls placed within the last 15 minutes)
                    if (number != null && (currentTime - date < 900000)) {
                        String cleanRecordNumber = number.replaceAll("[^\\d+]", "");
                        if (cleanRecordNumber.contains(cleanNumber) || cleanNumber.contains(cleanRecordNumber)) {
                            return cursor.getInt(cursor.getColumnIndex(CallLog.Calls.DURATION));
                        }
                    }
                } while (cursor.moveToNext());
            }
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            if (cursor != null) cursor.close();
        }
        return -1;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CALL_PERMISSION) {
            boolean callGranted = false;
            boolean logGranted = false;
            
            for (int i = 0; i < permissions.length; i++) {
                if (permissions[i].equals(android.Manifest.permission.CALL_PHONE)) {
                    callGranted = (grantResults[i] == android.content.pm.PackageManager.PERMISSION_GRANTED);
                } else if (permissions[i].equals(android.Manifest.permission.READ_CALL_LOG)) {
                    logGranted = (grantResults[i] == android.content.pm.PackageManager.PERMISSION_GRANTED);
                }
            }

            if (callGranted) {
                if (!logGranted) {
                    Toast.makeText(this, "未授予通话记录读取权限，App无法自动提取拨打时长", Toast.LENGTH_LONG).show();
                }
                if (pendingPhoneUrl != null) {
                    placeDirectCall(pendingPhoneUrl);
                }
            } else {
                Toast.makeText(this, "未授予直接通话权限，已切换为系统拨号盘", Toast.LENGTH_SHORT).show();
                if (pendingPhoneUrl != null) {
                    fallbackToDial(pendingPhoneUrl);
                }
            }
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
