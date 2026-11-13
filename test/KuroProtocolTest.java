import local.qqbot.kuro.KuroProtocol;
import org.json.JSONObject;
import java.util.concurrent.atomic.AtomicInteger;

public final class KuroProtocolTest {
    private static final String TOKEN="SYNTHETIC_ANDROID_TOKEN_123456";
    interface Action { void run() throws Exception; }
    static void check(boolean value) { if(!value)throw new AssertionError("protocol assertion failed"); }
    static void rejects(Action action) throws Exception {
        try { action.run(); throw new AssertionError("expected controlled failure"); }
        catch(KuroProtocol.ToolException error){check(!error.getMessage().contains(TOKEN));}
    }
    public static void main(String[] args) throws Exception {
        AtomicInteger calls=new AtomicInteger();
        KuroProtocol.Transport success=(url,headers,body)->{
            calls.incrementAndGet();check(url.equals("https://api.kurobbs.com/user/sdkLogin"));
            check(headers.get("devCode").equals("same-device-123"));check(body.contains("devCode=same-device-123"));
            check(body.contains("mobile=13800000000")&&body.contains("code=123456"));check(headers.get("source").equals("android"));
            return "{\"code\":200,\"data\":{\"token\":\""+TOKEN+"\",\"userId\":12345,\"refreshToken\":\"DO_NOT_EXPORT\"}}";
        };
        rejects(()->KuroProtocol.login("bad","123456","same-device-123","distinct123",success));
        rejects(()->KuroProtocol.login("13800000000","bad","same-device-123","distinct123",success));
        check(calls.get()==0);
        JSONObject credential=KuroProtocol.login("13800000000","123456","same-device-123","distinct123",success);
        check(calls.get()==1);check(credential.getString("token").equals(TOKEN));check(credential.getString("userId").equals("12345"));
        check(credential.getString("devCode").equals("same-device-123"));check(!credential.has("refreshToken"));
        check(KuroProtocol.extract(TOKEN,null).getString("token").equals(TOKEN));
        check(KuroProtocol.extract("{\"data\":{\"token\":\""+TOKEN+"\",\"userId\":\"12345\",\"devCode\":\"device123\"}}",null).getString("devCode").equals("device123"));
        for(String invalid:new String[]{"{", "short", "bad\ntoken123", "{\"code\":220,\"data\":{\"token\":\""+TOKEN+"\"}}",
            "{\"token\":\""+TOKEN+"\",\"userId\":\"123\\nInjected\"}", "{\"code\":\"200\",\"token\":\""+TOKEN+"\"}"})
            rejects(()->KuroProtocol.extract(invalid,null));
        rejects(()->KuroProtocol.extract(new String(new char[24001]).replace('\0','A'),null));
        for(String body:new String[]{"{\"code\":220,\"msg\":\""+TOKEN+"\"}","{\"code\":-130}","{\"code\":1034}",
            "{\"code\":200,\"success\":false,\"data\":{\"token\":\""+TOKEN+"\"}}", "{\"code\":200,\"data\":{\"token\":\""+TOKEN+"\"}}", "not json"})
            rejects(()->KuroProtocol.login("13800000000","123456","same-device-123","distinct123",(u,h,b)->body));
        rejects(()->KuroProtocol.login("13800000000","123456","same-device-123","distinct123",(u,h,b)->{throw new java.io.IOException(TOKEN);}));
        System.out.println(KuroProtocol.command(credential));
    }
}
