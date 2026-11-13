package local.qqbot.kuro;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.os.SystemClock;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private LinearLayout root;
    private EditText mobile, code, raw;
    private CheckBox confirm;
    private TextView status, output;
    private Button copy;
    private final ArrayList<Button> actions = new ArrayList<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile HttpsURLConnection activeRequest;
    private boolean busy;
    private long lastLogin = -5000;
    private int generation;
    private String command = "";
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    @Override public void onCreate(Bundle state) {
        super.onCreate(null);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(Color.rgb(237,244,240));
        getWindow().setNavigationBarColor(Color.rgb(237,244,240));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(Color.rgb(237,244,240));
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(22),dp(28),dp(22),dp(36));
        root.setSaveEnabled(false); root.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        // Target 35 draws edge to edge. Keep all controls below system bars and above the keyboard.
        root.setOnApplyWindowInsetsListener((view,insets) -> {
            view.setPadding(dp(22)+insets.getSystemWindowInsetLeft(),dp(20)+insets.getSystemWindowInsetTop(),dp(22)+insets.getSystemWindowInsetRight(),dp(28)+insets.getSystemWindowInsetBottom());
            return insets;
        });
        scroll.addView(root); setContentView(scroll); root.requestApplyInsets();
        text("库街区 Token 工具",28,true);
        text("安卓本机版 1.1.0 · Android 8.0+\n无需 Python，仅访问官方 HTTPS，不保存账号数据。",14,false);
        text("1 官网领取短信",21,true);
        text("手动完成人机验证并获取验证码。收到短信后不要点击官网登录，返回本 App 输入。",16,false);
        button("打开库街区官网",() -> {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(KuroProtocol.WEBSITE))); }
            catch (Exception error) { status.setText("未找到浏览器，请安装浏览器后重试。"); }
        });
        text("2 输入自己的手机号和验证码",21,true);
        mobile = input("中国大陆手机号",InputType.TYPE_CLASS_PHONE,11);
        code = input("短信验证码",InputType.TYPE_CLASS_NUMBER|InputType.TYPE_NUMBER_VARIATION_PASSWORD,8);
        confirm = new CheckBox(this); confirm.setText("我已知悉：新登录可能让库街区 App 旧会话失效。"); confirm.setTextSize(15); confirm.setSaveEnabled(false); root.addView(confirm);
        button("获取 token 并生成命令",this::login);
        text("本工具不自动发短信、不通过人机验证。官方拒绝时请停止重试，使用下方已有响应提取。",14,false);
        text("已有登录响应：离线提取",21,true);
        text("粘贴自己的 App 登录响应 JSON 或原始 token。只解析本机文本，不联网，也不验证登录是否有效。",16,false);
        raw = input("App 登录响应 JSON 或 token",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,24000); raw.setMinLines(4);
        button("提取绑定命令",() -> {
            try { show(KuroProtocol.extract(raw.getText().toString(),null)); }
            catch (KuroProtocol.ToolException error) { clearOutput(); status.setText(error.getMessage()); }
        });
        status = text("获取后将完整命令只发到机器人私聊。",15,false);
        output = text("",14,false); output.setTypeface(Typeface.MONOSPACE); output.setTextIsSelectable(true); output.setSaveEnabled(false);
        copy = button("复制绑定命令",() -> {
            if (command.isEmpty()) return;
            ClipboardManager clipboard = (ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
            ClipData clip = ClipData.newPlainText("库街区绑定命令",command);
            PersistableBundle extras = new PersistableBundle(); extras.putBoolean("android.content.extra.IS_SENSITIVE",true); clip.getDescription().setExtras(extras);
            clipboard.setPrimaryClip(clip); status.setText("已复制，请私聊机器人；以“绑定成功”回执为准。");
        }); copy.setEnabled(false);
        button("清空本页凭据",() -> { mobile.setText(""); code.setText(""); raw.setText(""); confirm.setChecked(false); clearOutput(); status.setText("已清空本页。若曾复制，请勿将系统剪贴板内容粘贴到群里。"); });
        text("游戏 UID、抽卡链接和 refreshToken 不能替代 App token。关闭 App 后不保留输入；复制操作会将命令放入系统剪贴板。",14,false);
    }
    private TextView text(String value,int size,boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(25,58,50));
        view.setPadding(0,dp(bold?20:8),0,dp(8)); if(bold)view.setTypeface(null,Typeface.BOLD); root.addView(view); return view;
    }
    private EditText input(String hint,int type,int limit) {
        EditText input = new EditText(this); input.setHint(hint); input.setInputType(type); input.setTextSize(16);
        input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(limit)}); input.setSaveEnabled(false);
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); root.addView(input); return input;
    }
    private Button button(String title,Runnable action) {
        Button button = new Button(this); button.setText(title); button.setTextSize(16); button.setAllCaps(false);
        button.setOnClickListener(view -> { if(!busy)action.run(); }); actions.add(button); root.addView(button); return button;
    }
    private void clearOutput() { command=""; output.setText(""); copy.setEnabled(false); }
    private void show(JSONObject value) { command=KuroProtocol.command(value); output.setText(command); copy.setEnabled(true); status.setText("绑定命令已生成，只发送到机器人私聊。"); }
    private void setBusy(boolean value) { busy=value; for(Button b:actions)b.setEnabled(!value); copy.setEnabled(!value&&!command.isEmpty()); }
    private void login() {
        String phone=mobile.getText().toString().trim(), sms=code.getText().toString().trim();
        try { KuroProtocol.validateLogin(phone,sms); }
        catch(KuroProtocol.ToolException error){status.setText(error.getMessage()); return;}
        if(!confirm.isChecked()){status.setText("请先确认新登录可能使 App 旧会话失效。"); return;}
        if(SystemClock.elapsedRealtime()-lastLogin<5000){status.setText("请等待 5 秒再尝试。"); return;}
        lastLogin=SystemClock.elapsedRealtime(); clearOutput(); setBusy(true); status.setText("正在直连库街区官方接口…"); final int task=++generation;
        worker.execute(() -> {
            JSONObject result=null;String message=null;
            try { result=KuroProtocol.login(phone,sms,UUID.randomUUID().toString().replace("-",""),UUID.randomUUID().toString(),this::post); }
            catch(KuroProtocol.ToolException error){message=error.getMessage();}
            catch(Exception error){message="获取未完成，请稍后重试；请勿公开含凭据的内容。";}
            final JSONObject value=result; final String errorText=message;
            runOnUiThread(() -> {if(isFinishing()||isDestroyed()||generation!=task)return;setBusy(false);code.setText("");if(value!=null)show(value);else status.setText(errorText);});
        });
    }
    private String post(String url,Map<String,String> headers,String body) throws IOException {
        if(!KuroProtocol.LOGIN_URL.equals(url))throw new IOException("unsupported endpoint");
        HttpsURLConnection conn=(HttpsURLConnection)new URL(url).openConnection(); activeRequest=conn;
        try {
            conn.setRequestMethod("POST");conn.setConnectTimeout(20000);conn.setReadTimeout(20000);conn.setInstanceFollowRedirects(false);conn.setUseCaches(false);conn.setDoOutput(true);
            for(Map.Entry<String,String> entry:headers.entrySet())conn.setRequestProperty(entry.getKey(),entry.getValue());
            byte[] form=body.getBytes(StandardCharsets.UTF_8);conn.setFixedLengthStreamingMode(form.length);
            try(OutputStream stream=conn.getOutputStream()){stream.write(form);}
            if(conn.getResponseCode()!=200)throw new IOException("official endpoint unavailable");
            try(InputStream stream=conn.getInputStream();ByteArrayOutputStream output=new ByteArrayOutputStream()){
                byte[] buffer=new byte[8192];int read;
                while((read=stream.read(buffer))!=-1){if(output.size()+read>1024*1024)throw new IOException("response too large");output.write(buffer,0,read);}
                return new String(output.toByteArray(),StandardCharsets.UTF_8);
            }
        } finally {conn.disconnect();activeRequest=null;}
    }
    @Override protected void onSaveInstanceState(Bundle state) { /* Never persist credential text. */ }
    @Override protected void onDestroy() {generation++;worker.shutdownNow();HttpsURLConnection connection=activeRequest;if(connection!=null)connection.disconnect();command="";super.onDestroy();}
}
