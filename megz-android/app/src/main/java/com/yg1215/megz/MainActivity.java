package com.yg1215.megz;

import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.CallLog;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.File;
import java.io.FileInputStream;
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
    private View loadingLayout;
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

    // Standard Chinese Android ROM Call Recording paths
    private static final String[] RECORDING_PATHS = {
        "/MIUI/sound_recorder/call_rec", // Xiaomi MIUI
        "/Sounds/CallRecord",            // Huawei EMUI
        "/record",                       // Huawei alternate
        "/Record/PhoneRecord",           // OPPO ColorOS
        "/Record/Call",                  // VIVO FuntouchOS
        "/录音/通话录音"                   // General Chinese ROMs
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // 1. Force Hardware Acceleration at Window level for high performance rendering
        getWindow().setFlags(
            android.view.WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            android.view.WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED
        );

        // 2. Unlock High Screen Refresh Rate (90Hz / 120Hz / 144Hz) programmatically to resolve stuttering
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            try {
                android.view.Display display = getWindowManager().getDefaultDisplay();
                android.view.Display.Mode[] modes = display.getSupportedModes();
                if (modes != null && modes.length > 0) {
                    android.view.Display.Mode bestMode = null;
                    float highestRate = 0f;
                    for (android.view.Display.Mode mode : modes) {
                        if (mode.getRefreshRate() > highestRate) {
                            highestRate = mode.getRefreshRate();
                            bestMode = mode;
                        }
                    }
                    if (bestMode != null && highestRate > 60f) {
                        android.view.WindowManager.LayoutParams lp = getWindow().getAttributes();
                        lp.preferredDisplayModeId = bestMode.getModeId();
                        getWindow().setAttributes(lp);
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        // 3. Edge-to-edge full-screen: content fills entire screen behind system bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
        getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }

        setContentView(R.layout.activity_main);

        // Bind layout views
        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);
        offlineLayout = findViewById(R.id.offlineLayout);
        configLayout = findViewById(R.id.configLayout);
        loadingLayout = findViewById(R.id.loadingLayout);
        editUrl = findViewById(R.id.editUrl);
        switchDualSim = findViewById(R.id.switchDualSim);
        radioGroupInterval = findViewById(R.id.radioGroupInterval);
        radio5 = findViewById(R.id.radio5);
        radio10 = findViewById(R.id.radio10);
        btnSaveUrl = findViewById(R.id.btnSaveUrl);
        btnRetry = findViewById(R.id.btnRetry);


        // Load targeted configurations (defaulting to the user's domain immediately!)
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        targetUrl = prefs.getString(KEY_TARGET_URL, "https://go.yg1215.dpdns.org/");
        
        // If not saved in SharedPreferences yet, save the default targetUrl immediately
        if (!prefs.contains(KEY_TARGET_URL)) {
            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(KEY_TARGET_URL, targetUrl);
            editor.apply();
        }

        dualSimEnabled = prefs.getBoolean(KEY_DUAL_SIM, true);
        rotationInterval = prefs.getInt(KEY_ROTATION_INTERVAL, 5);
        dialCount = prefs.getInt(KEY_DIAL_COUNT, 0);

        // Populate config UI values
        editUrl.setText(targetUrl);
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

            boolean urlChanged = !inputUrl.equals(targetUrl);
            targetUrl = inputUrl;
            dualSimEnabled = isDualSimChecked;
            rotationInterval = selectedInterval;

            configLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            
            if (urlChanged) {
                webView.loadUrl(targetUrl);
            }
            Toast.makeText(MainActivity.this, "配置已成功保存！", Toast.LENGTH_SHORT).show();
        });

        btnRetry.setOnClickListener(v -> {
            offlineLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.reload();
        });

        // ALWAYS directly show webView and load targetUrl immediately without prompting
        configLayout.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        initWebViewSettings();
        webView.loadUrl(targetUrl);
        
        // Bind and setup the hidden top-right corner settings trigger!
        findViewById(R.id.btnHiddenSettings).setOnClickListener(v -> {
            if (configLayout.getVisibility() == View.VISIBLE) {
                configLayout.setVisibility(View.GONE);
            } else {
                // Populate/reload current config UI values
                editUrl.setText(targetUrl);
                switchDualSim.setChecked(dualSimEnabled);
                if (rotationInterval == 10) {
                    radio10.setChecked(true);
                } else {
                    radio5.setChecked(true);
                }
                configLayout.setVisibility(View.VISIBLE);
            }
        });

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
        
        // Ensure background is transparent to let padding show the app theme background
        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        
        // Responsive Scaling viewport setup
        webSettings.setUseWideViewPort(true);
        webSettings.setLoadWithOverviewMode(true);
        webSettings.setBuiltInZoomControls(true);
        webSettings.setDisplayZoomControls(false); // Hide ugly browser zoom triggers
        
        // WebApp performance configurations
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        
        // Force the WebView to render using GPU Hardware layer for ultra-smooth rendering
        webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);

        // Customize clients
        webView.setWebViewClient(new CustomWebViewClient());
        webView.setWebChromeClient(new CustomWebChromeClient());

        // Register custom JS Interface for Recording Files check
        webView.addJavascriptInterface(new DialerJSInterface(), "AndroidDialer");

        // Asynchronously check for in-app updates
        checkForUpdates();
    }

    // JS Bridge class accessible in dialer_html.js
    public class DialerJSInterface {
        @JavascriptInterface
        public boolean hasRecording(String phone) {
            File rec = findCallRecordingFile(phone);
            return rec != null && rec.exists();
        }
    }

    // Chinese Android ROM call recording file scanner
    private File findCallRecordingFile(String phoneNumber) {
        String cleanNumber = phoneNumber.replaceAll("[^\\d]", "");
        if (cleanNumber.isEmpty()) return null;

        // 1. Try to query via MediaStore (Highly robust on Android 11+ and Tiramisu+)
        try {
            Uri uri = android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String[] projection = {
                android.provider.MediaStore.Audio.Media.DATA,
                android.provider.MediaStore.Audio.Media.DATE_MODIFIED
            };
            
            // Search for audio files whose file path or display name contains the phone number
            String selection = android.provider.MediaStore.Audio.Media.DATA + " LIKE ? OR " +
                               android.provider.MediaStore.Audio.Media.DISPLAY_NAME + " LIKE ?";
            String[] selectionArgs = new String[]{"%" + cleanNumber + "%", "%" + cleanNumber + "%"};
            String sortOrder = android.provider.MediaStore.Audio.Media.DATE_MODIFIED + " DESC";
            
            Cursor cursor = getContentResolver().query(uri, projection, selection, selectionArgs, sortOrder);
            if (cursor != null) {
                if (cursor.moveToFirst()) {
                    String filePath = cursor.getString(cursor.getColumnIndexOrThrow(android.provider.MediaStore.Audio.Media.DATA));
                    cursor.close();
                    if (filePath != null) {
                        File file = new File(filePath);
                        if (file.exists() && file.isFile()) {
                            return file;
                        }
                    }
                } else {
                    cursor.close();
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }

        // 2. Fallback to direct directory scanning (for older versions or if MediaStore hasn't indexed yet)
        File sdCard = Environment.getExternalStorageDirectory();
        File bestMatch = null;
        long latestTime = 0;

        for (String path : RECORDING_PATHS) {
            File dir = new File(sdCard, path);
            if (dir.exists() && dir.isDirectory()) {
                File[] files = dir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        if (f.isFile() && f.getName().contains(cleanNumber)) {
                            long fileTime = f.lastModified();
                            if (fileTime > latestTime) {
                                latestTime = fileTime;
                                bestMatch = f;
                            }
                        }
                    }
                }
            }
        }
        return bestMatch;
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
                
                // Determine targeted permissions based on SDK Version (Android 13+)
                String[] permissions;
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                    permissions = new String[]{
                        android.Manifest.permission.CALL_PHONE,
                        android.Manifest.permission.READ_CALL_LOG,
                        android.Manifest.permission.READ_MEDIA_AUDIO
                    };
                } else {
                    permissions = new String[]{
                        android.Manifest.permission.CALL_PHONE,
                        android.Manifest.permission.READ_CALL_LOG,
                        android.Manifest.permission.READ_EXTERNAL_STORAGE
                    };
                }

                // Check permissions
                boolean hasAll = true;
                for (String p : permissions) {
                    if (androidx.core.content.ContextCompat.checkSelfPermission(MainActivity.this, p) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        hasAll = false;
                        break;
                    }
                }

                if (hasAll) {
                    placeDirectCall(url);
                } else {
                    androidx.core.app.ActivityCompat.requestPermissions(MainActivity.this, permissions, REQUEST_CALL_PERMISSION);
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

        // Intercept local recording file streams and proxy them under same origin to bypass Same-Origin-Policy
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String path = uri.getPath();
            
            if (path != null && path.equals("/api/local-recording")) {
                String phone = uri.getQueryParameter("phone");
                if (phone != null) {
                    File file = findCallRecordingFile(phone);
                    if (file != null && file.exists()) {
                        try {
                            FileInputStream fis = new FileInputStream(file);
                            
                            // Map extension to correct audio MIME type
                            String mimeType = "audio/mpeg";
                            if (file.getName().endsWith(".wav")) mimeType = "audio/wav";
                            else if (file.getName().endsWith(".amr")) mimeType = "audio/amr";
                            else if (file.getName().endsWith(".m4a")) mimeType = "audio/mp4";
                            
                            return new WebResourceResponse(mimeType, "UTF-8", fis);
                        } catch (Exception e) {
                            e.printStackTrace();
                        }
                    }
                }
            }
            return super.shouldInterceptRequest(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (progressBar != null) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(0);
            }
            
            // Show premium loading overlay immediately when start loading
            if (loadingLayout != null) {
                loadingLayout.setVisibility(View.VISIBLE);
                loadingLayout.setAlpha(1.0f);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (progressBar != null) progressBar.setVisibility(View.GONE);

            // Smoothly fade out the loading overlay with professional alpha transition
            if (loadingLayout != null && loadingLayout.getVisibility() == View.VISIBLE) {
                loadingLayout.animate()
                        .alpha(0.0f)
                        .setDuration(400)
                        .withEndAction(() -> {
                            loadingLayout.setVisibility(View.GONE);
                            loadingLayout.setAlpha(1.0f);
                        });
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // Only trigger offline layout on main page failures, to avoid breaking minor sub-frames
            if (request.isForMainFrame()) {
                webView.setVisibility(View.GONE);
                offlineLayout.setVisibility(View.VISIBLE);
                
                // Instantly hide loading overlay so the user can see offline retry view
                if (loadingLayout != null) {
                    loadingLayout.setVisibility(View.GONE);
                }
            }
        }
    }

    // Custom WebChromeClient to enable file uploads and native dialog alerts
    private class CustomWebChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (progressBar == null) return;
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
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUI();
    }

    @Override
    protected void onResume() {
        super.onResume();

        // Re-apply immersive full-screen
        hideSystemUI();

        // Automated Outgoing Call Duration query injection
        if (pendingPhoneUrl != null) {
            String phoneNumber = pendingPhoneUrl.replace("tel:", "").trim();
            pendingPhoneUrl = null; // Clear pending call immediately to avoid double execution on reload
            
            // Query latest Outgoing Call duration
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

    // ==================== App Auto-Update Feature ====================

    private void checkForUpdates() {
        if (targetUrl == null || targetUrl.isEmpty()) return;

        new Thread(() -> {
            try {
                // Construct the version check API URL (e.g. targetUrl + "/api/app-version")
                String apiUrl = targetUrl;
                if (!apiUrl.endsWith("/")) {
                    apiUrl += "/";
                }
                apiUrl += "api/app-version";

                java.net.URL url = new java.net.URL(apiUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setRequestMethod("GET");

                if (conn.getResponseCode() == 200) {
                    java.io.InputStream is = conn.getInputStream();
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is, "UTF-8"));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                    reader.close();
                    is.close();

                    String json = sb.toString();
                    org.json.JSONObject obj = new org.json.JSONObject(json);
                    int serverVersionCode = obj.getInt("versionCode");
                    String serverVersionName = obj.getString("versionName");
                    String apkUrl = obj.getString("apkUrl");
                    String changeLog = obj.optString("changeLog", "");

                    int currentVersionCode = getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;

                    if (serverVersionCode > currentVersionCode) {
                        runOnUiThread(() -> showUpdateDialog(serverVersionName, apkUrl, changeLog));
                    }
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }

    private void showUpdateDialog(String versionName, String apkUrl, String changeLog) {
        new AlertDialog.Builder(this)
                .setTitle("发现新版本 V" + versionName)
                .setMessage("更新日志：\n" + changeLog + "\n\n是否立即下载并更新？")
                .setPositiveButton("立即更新", (dialog, which) -> {
                    // Check Install Unknown Apps permission on Oreo+ before downloading
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        if (!getPackageManager().canRequestPackageInstalls()) {
                            try {
                                Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                                intent.setData(Uri.parse("package:" + getPackageName()));
                                startActivity(intent);
                                Toast.makeText(this, "请开启允许安装未知应用权限，然后重新点击更新！", Toast.LENGTH_LONG).show();
                            } catch (Exception e) {
                                e.printStackTrace();
                            }
                            return;
                        }
                    }
                    startApkDownload(apkUrl);
                })
                .setNegativeButton("以后再说", null)
                .setCancelable(false)
                .show();
    }

    private void startApkDownload(String apkUrl) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("正在下载最新版更新包...");
        builder.setCancelable(false);

        ProgressBar pb = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        pb.setIndeterminate(false);
        pb.setMax(100);
        pb.setProgress(0);

        int padding = (int) (16 * getResources().getDisplayMetrics().density);
        android.widget.LinearLayout layout = new android.widget.LinearLayout(this);
        layout.setOrientation(android.widget.LinearLayout.VERTICAL);
        layout.setPadding(padding, padding, padding, padding);
        layout.addView(pb);
        builder.setView(layout);

        AlertDialog progressDialog = builder.create();
        progressDialog.show();

        new Thread(() -> {
            try {
                java.net.URL url = new java.net.URL(apkUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.connect();

                int fileLength = conn.getContentLength();
                java.io.InputStream input = new java.io.BufferedInputStream(url.openStream());

                File apkFile = new File(getExternalCacheDir(), "megz_update.apk");
                java.io.OutputStream output = new java.io.FileOutputStream(apkFile);

                byte[] data = new byte[4096];
                long total = 0;
                int count;
                while ((count = input.read(data)) != -1) {
                    total += count;
                    if (fileLength > 0) {
                        int progress = (int) (total * 100 / fileLength);
                        runOnUiThread(() -> pb.setProgress(progress));
                    }
                    output.write(data, 0, count);
                }

                output.flush();
                output.close();
                input.close();

                runOnUiThread(() -> {
                    progressDialog.dismiss();
                    installApk(apkFile);
                });
            } catch (Exception e) {
                e.printStackTrace();
                runOnUiThread(() -> {
                    progressDialog.dismiss();
                    Toast.makeText(MainActivity.this, "下载更新失败，请检查网络！", Toast.LENGTH_SHORT).show();
                });
            }
        }).start();
    }

    private void installApk(File file) {
        if (file == null || !file.exists()) return;

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            Uri apkUri = androidx.core.content.FileProvider.getUriForFile(this, "com.yg1215.megz.fileprovider", file);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else {
            intent.setDataAndType(Uri.fromFile(file), "application/vnd.android.package-archive");
        }
        
        try {
            startActivity(intent);
        } catch (Exception e) {
            e.printStackTrace();
            Toast.makeText(this, "无法启动安装程序，请手动安装！", Toast.LENGTH_LONG).show();
        }
    }

    private void hideSystemUI() {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }
    }

    private int getStatusBarHeight() {
        int result = 0;
        int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resourceId > 0) {
            result = getResources().getDimensionPixelSize(resourceId);
        }
        if (result == 0) {
            result = (int) (24 * getResources().getDisplayMetrics().density);
        }
        return result;
    }

    private int getNavigationBarHeight() {
        int result = 0;
        int resourceId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
        if (resourceId > 0) {
            result = getResources().getDimensionPixelSize(resourceId);
        }
        if (result == 0) {
            result = (int) (48 * getResources().getDisplayMetrics().density);
        }
        return result;
    }

}
