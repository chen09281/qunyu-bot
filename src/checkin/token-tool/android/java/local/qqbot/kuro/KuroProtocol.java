package local.qqbot.kuro;

import org.json.JSONException;
import org.json.JSONObject;
import java.net.URLEncoder;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

/** Fixed official protocol. No account storage, SMS sender or captcha automation. */
public final class KuroProtocol {
    public static final String LOGIN_URL = "https://api.kurobbs.com/user/sdkLogin";
    public static final String WEBSITE = "https://www.kurobbs.com/mc/home/";
    public interface Transport { String post(String url, Map<String, String> headers, String body) throws IOException; }
    public static final class ToolException extends Exception {
        public ToolException(String message) { super(message); }
    }
    private KuroProtocol() {}
    private static String identifier(Object value, String name, int max) throws ToolException {
        if (!(value instanceof String) || !((String)value).matches("[\\x21-\\x7e]{8," + max + "}"))
            throw new ToolException(name + " 格式不正确，请复制完整值。");
        return (String)value;
    }
    public static void validateLogin(String mobile, String code) throws ToolException {
        if (mobile == null || !mobile.matches("1[3-9][0-9]{9}")) throw new ToolException("请填写中国大陆手机号。");
        if (code == null || !code.matches("[0-9]{4,8}")) throw new ToolException("请填写刚收到的 4 至 8 位短信验证码。");
    }
    public static JSONObject extract(String raw, String device) throws ToolException {
        if (raw == null || raw.length() > 24000) throw new ToolException("请提供完整登录响应或 token，最多 24000 字符。");
        raw = raw.trim();
        try {
            JSONObject outer = raw.startsWith("{") ? new JSONObject(raw) : new JSONObject().put("token", raw);
            if (outer.has("code") && (!(outer.opt("code") instanceof Integer) || outer.getInt("code") != 200 || Boolean.FALSE.equals(outer.opt("success"))))
                throw new ToolException("这是失败响应，没有可用 token。");
            JSONObject data = outer.optJSONObject("data"); if (data == null) data = outer;
            JSONObject result = new JSONObject().put("token", identifier(data.opt("token"), "token", 8192));
            if (data.has("userId")) {
                Object id = data.opt("userId");
                if (!(id instanceof String || id instanceof Number) || !String.valueOf(id).matches("[0-9]{1,30}"))
                    throw new ToolException("userId 应为库街区社区用户 ID。");
                result.put("userId", String.valueOf(id));
            }
            Object dev = device != null ? device : data.has("devCode") ? data.opt("devCode") : outer.opt("devCode");
            if (dev != null) result.put("devCode", identifier(dev, "devCode", 256));
            return result;
        } catch (JSONException error) { throw new ToolException("JSON 不完整，请复制完整登录响应。"); }
    }
    public static JSONObject login(String mobile, String code, String device, String distinct, Transport transport) throws ToolException {
        validateLogin(mobile, code); identifier(device, "devCode", 256);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/x-www-form-urlencoded"); headers.put("devCode", device); headers.put("distinct_id", distinct);
        headers.put("source", "android"); headers.put("version", "2.2.1"); headers.put("versionCode", "2210");
        headers.put("osVersion", "Android"); headers.put("countryCode", "CN"); headers.put("model", "23127PN0CC");
        headers.put("lang", "zh-Hans"); headers.put("channelId", "2"); headers.put("User-Agent", "okhttp/3.11.0");
        try {
            String body = "mobile=" + URLEncoder.encode(mobile, "UTF-8") + "&code=" + URLEncoder.encode(code, "UTF-8")
                + "&devCode=" + URLEncoder.encode(device, "UTF-8") + "&gameList=";
            JSONObject response = new JSONObject(transport.post(LOGIN_URL, headers, body));
            Object status = response.opt("code");
            if (!(status instanceof Integer) || ((Integer)status) != 200 || Boolean.FALSE.equals(response.opt("success"))) {
                if (Integer.valueOf(-130).equals(status)) throw new ToolException("验证码错误或过期，请回官网重新领取；领取后不要先点官网登录。");
                if (Integer.valueOf(220).equals(status) || Integer.valueOf(1034).equals(status))
                    throw new ToolException("官方要求安全验证。请在官网手动完成；仍被拦截时使用已有响应提取。");
                throw new ToolException("官方未完成登录。请检查验证码，或使用已有响应提取。");
            }
            JSONObject result = extract(response.toString(), device);
            if (!result.has("userId")) throw new ToolException("登录响应缺少社区用户 ID，已停止输出。");
            return result;
        } catch (IOException error) { throw new ToolException("无法连接官方接口，请检查网络；本工具不会自动重试。"); }
        catch (JSONException error) { throw new ToolException("官方响应格式异常，请稍后重试。"); }
    }
    public static String command(JSONObject credential) { return "/签到 绑定 库街区 " + credential.toString(); }
}
