const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
});
const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/") + "=".repeat((4-s.length%4)%4)), c=>c.charCodeAt(0));
const cookie = (request, name) => (request.headers.get("Cookie") || "").split(";").map(v=>v.trim()).find(v=>v.startsWith(name+"="))?.slice(name.length+1);
const setCookie = (name,value,maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const clearCookie = (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}
async function seal(data, secret) {
  const payload = b64(enc.encode(JSON.stringify(data)));
  return payload + "." + await sign(payload, secret);
}
async function unseal(value, secret) {
  if (!value || !secret) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const expected = await sign(parts[0], secret);
  if (expected.length !== parts[1].length) return null;
  const a=enc.encode(expected), b=enc.encode(parts[1]);
  if (!crypto.subtle.timingSafeEqual) {
    let diff=0; for(let i=0;i<a.length;i++) diff |= a[i]^b[i];
    if(diff) return null;
  } else if(!crypto.subtle.timingSafeEqual(a,b)) return null;
  try { const data=JSON.parse(new TextDecoder().decode(fromB64(parts[0]))); return data.exp>Date.now()?data:null; } catch { return null; }
}
function sameOrigin(request) {
  const origin=request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}
async function getSession(request, env) {
  return unseal(cookie(request,"acj_session"), env.SESSION_SECRET);
}
async function discordFetch(path, token) {
  return fetch("https://discord.com/api/v10"+path, {headers:{Authorization:"Bearer "+token}});
}
function redirect(url, headers={}) { const h=new Headers({Location:url}); for (const [k,v] of Object.entries(headers)) { if (Array.isArray(v)) for (const item of v) h.append(k,item); else h.set(k,v); } return new Response(null,{status:302,headers:h}); }

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.pathname==="/api/health") return json({ok:true,service:"Arab City RP — Ministry Of Justice",stage:"authentication-setup-required"});

    if(url.pathname==="/auth/login" && request.method==="GET") {
      if(!env.DISCORD_CLIENT_ID || !env.DISCORD_REDIRECT_URI) return json({error:"Discord OAuth is not configured yet."},503);
      const state=b64(crypto.getRandomValues(new Uint8Array(24)));
      const authorize=new URL("https://discord.com/oauth2/authorize");
      authorize.searchParams.set("client_id",env.DISCORD_CLIENT_ID);
      authorize.searchParams.set("response_type","code");
      authorize.searchParams.set("redirect_uri",env.DISCORD_REDIRECT_URI);
      authorize.searchParams.set("scope","identify guilds.members.read");
      authorize.searchParams.set("state",state);
      return redirect(authorize.toString(),{"Set-Cookie":setCookie("acj_oauth_state",state,600)});
    }

    if(url.pathname==="/auth/callback" && request.method==="GET") {
      let oauthStage="callback-entry";
      const clearState=clearCookie("acj_oauth_state");
      try {
        oauthStage="validate-state";
        const state=url.searchParams.get("state"), saved=cookie(request,"acj_oauth_state"), code=url.searchParams.get("code");
        if(!state || !saved || state!==saved || !code) return redirect("/?login=invalid",{"Set-Cookie":clearState});
        oauthStage="validate-config";
        if(!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_REDIRECT_URI || !env.DISCORD_GUILD_ID || !env.MINISTRY_ROLE_ID || !env.SESSION_SECRET) {
          console.error("OAuth configuration missing", {
            clientId:!!env.DISCORD_CLIENT_ID, clientSecret:!!env.DISCORD_CLIENT_SECRET,
            redirectUri:!!env.DISCORD_REDIRECT_URI, guildId:!!env.DISCORD_GUILD_ID,
            ministryRoleId:!!env.MINISTRY_ROLE_ID, sessionSecret:!!env.SESSION_SECRET
          });
          return json({error:"OAuth configuration is incomplete."},503,{"Set-Cookie":clearState});
        }
        oauthStage="exchange-code";
        const form=new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:"authorization_code",code,redirect_uri:env.DISCORD_REDIRECT_URI});
        const tokenRes=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});
        if(!tokenRes.ok) {
          const detail=(await tokenRes.text()).slice(0,500);
          console.error("OAuth token exchange rejected",tokenRes.status,detail);
          return json({error:"Discord token exchange failed.",stage:oauthStage,status:tokenRes.status},502,{"Set-Cookie":clearState});
        }
        oauthStage="parse-token";
        const token=await tokenRes.json();
        if(!token?.access_token) throw new Error("Discord token response did not include access_token");
        oauthStage="fetch-user";
        const userRes=await discordFetch("/users/@me",token.access_token);
        if(!userRes.ok) {
          console.error("Discord user lookup rejected",userRes.status,(await userRes.text()).slice(0,300));
          return json({error:"Discord user lookup failed.",stage:oauthStage,status:userRes.status},502,{"Set-Cookie":clearState});
        }
        const user=await userRes.json();
        if(!user?.id || !user?.username) throw new Error("Discord user response is missing required fields");
        oauthStage="fetch-guild-member";
        const memberRes=await discordFetch("/users/@me/guilds/"+env.DISCORD_GUILD_ID+"/member",token.access_token);
        if(!memberRes.ok) {
          console.error("Discord guild member lookup rejected",memberRes.status,(await memberRes.text()).slice(0,300));
          return json({error:"Discord guild membership lookup failed.",stage:oauthStage,status:memberRes.status},502,{"Set-Cookie":clearState});
        }
        const member=await memberRes.json();
        const roles=Array.isArray(member.roles)?member.roles:[];
        oauthStage="check-ministry-role";
        if(!roles.includes(env.MINISTRY_ROLE_ID)) return redirect("/?login=no-access",{"Set-Cookie":clearState});
        oauthStage="create-session";
        const session=await seal({id:user.id,username:user.username,global_name:user.global_name||user.username,avatar:user.avatar||null,roles,exp:Date.now()+6*60*60*1000},env.SESSION_SECRET);
        oauthStage="finish-login";
        return redirect("/members.html",{"Set-Cookie":[setCookie("acj_session",session,21600),clearState]});
      } catch (error) {
        const message=String(error?.message||error||"Unknown error").slice(0,500);
        console.error("OAuth callback exception",JSON.stringify({stage:oauthStage,name:error?.name||"Error",message,stack:error?.stack||""}));
        return json({error:"OAuth callback failed.",stage:oauthStage,detail:message},500,{"Set-Cookie":clearState});
      }
    }

    if(url.pathname==="/auth/logout" && request.method==="POST") {
      if(!sameOrigin(request)) return json({error:"Origin rejected"},403);
      return json({ok:true},200,{"Set-Cookie":clearCookie("acj_session")});
    }

    if(url.pathname==="/api/me" && request.method==="GET") {
      const session=await getSession(request,env);
      return session?json({authenticated:true,user:{id:session.id,username:session.username,displayName:session.global_name,avatar:session.avatar},roles:session.roles}):json({authenticated:false},401);
    }

    if(url.pathname==="/api/circulars" && request.method==="GET") {
      try {
        const {results}=await env.DB.prepare("SELECT id,title,body,author_discord_id,published_at FROM circulars ORDER BY published_at DESC LIMIT 50").all();
        return json({items:results||[]});
      } catch { return json({items:[],error:"Database is not initialized."},503); }
    }

    if(url.pathname==="/api/circulars" && request.method==="POST") {
      if(!sameOrigin(request)) return json({error:"Origin rejected"},403);
      const session=await getSession(request,env);
      if(!session) return json({error:"Sign in required"},401);
      if(!session.roles.includes(env.JUDGE_ROLE_ID) && !session.roles.includes(env.DEPUTY_JUDGE_ROLE_ID)) return json({error:"Insufficient permissions"},403);
      let body; try { body=await request.json(); } catch { return json({error:"Invalid JSON"},400); }
      const title=String(body.title||"").trim(), text=String(body.body||"").trim();
      if(!title || !text || title.length>160 || text.length>10000) return json({error:"Title/body is missing or too long"},400);
      const result=await env.DB.prepare("INSERT INTO circulars (title,body,author_discord_id) VALUES (?,?,?)").bind(title,text,session.id).run();
      await env.DB.prepare("INSERT INTO audit_log (actor_discord_id,action,target_type,target_id) VALUES (?,?,?,?)").bind(session.id,"publish_circular","circular",String(result.meta.last_row_id)).run();
      return json({ok:true,id:result.meta.last_row_id},201);
    }


    const privateSession = await getSession(request,env);
    const isMinistry = privateSession && privateSession.roles.includes(env.MINISTRY_ROLE_ID);
    const isJudge = privateSession && (privateSession.roles.includes(env.JUDGE_ROLE_ID) || privateSession.roles.includes(env.DEPUTY_JUDGE_ROLE_ID));
    if (url.pathname.startsWith("/api/") && !["/api/health","/api/me","/api/circulars"].includes(url.pathname) && !isMinistry) return json({error:"Ministry access required"},privateSession?403:401);

    if(url.pathname==="/api/cases" && request.method==="GET"){
      const {results}=await env.DB.prepare("SELECT * FROM cases ORDER BY created_at DESC LIMIT 100").all();
      return json({items:results||[]});
    }
    if(url.pathname==="/api/cases" && request.method==="POST"){
      if(!isJudge) return json({error:"Judge permission required"},403);
      let b;try{b=await request.json()}catch{return json({error:"Invalid JSON"},400)}
      const title=String(b.title||"").trim(),summary=String(b.summary||"").trim(),number=String(b.case_number||"").trim();
      if(!title||!summary||!number||title.length>180||summary.length>5000||number.length>50)return json({error:"راجع بيانات القضية"},400);
      const r=await env.DB.prepare("INSERT INTO cases(case_number,title,summary,created_by) VALUES(?,?,?,?)").bind(number,title,summary,privateSession.id).run();
      await env.DB.prepare("INSERT INTO audit_log(actor_discord_id,action,target_type,target_id) VALUES(?,?,?,?)").bind(privateSession.id,"create_case","case",String(r.meta.last_row_id)).run();
      return json({ok:true,id:r.meta.last_row_id},201);
    }
    if(url.pathname==="/api/meetings" && request.method==="GET"){
      const {results}=await env.DB.prepare("SELECT * FROM meetings ORDER BY meeting_at DESC LIMIT 100").all();return json({items:results||[]});
    }
    if(url.pathname==="/api/meetings" && request.method==="POST"){
      if(!isJudge)return json({error:"Judge permission required"},403);
      let b;try{b=await request.json()}catch{return json({error:"Invalid JSON"},400)}
      const title=String(b.title||"").trim(),details=String(b.details||"").trim(),at=String(b.meeting_at||"").trim(),location=String(b.location||"مقر الوزارة").trim();
      if(!title||!at||title.length>180||details.length>5000||location.length>160)return json({error:"راجع بيانات الاجتماع"},400);
      const r=await env.DB.prepare("INSERT INTO meetings(title,details,meeting_at,location,created_by) VALUES(?,?,?,?,?)").bind(title,details,at,location,privateSession.id).run();
      return json({ok:true,id:r.meta.last_row_id},201);
    }
    if(url.pathname==="/api/messages" && request.method==="GET"){
      const {results}=await env.DB.prepare("SELECT id,author_discord_id,author_name,body,created_at FROM messages ORDER BY id DESC LIMIT 100").all();return json({items:(results||[]).reverse()});
    }
    if(url.pathname==="/api/messages" && request.method==="POST"){
      let b;try{b=await request.json()}catch{return json({error:"Invalid JSON"},400)}
      const body=String(b.body||"").trim();if(!body||body.length>2000)return json({error:"الرسالة فارغة أو طويلة"},400);
      const name=String(privateSession.global_name||privateSession.username||"عضو").slice(0,80);
      const r=await env.DB.prepare("INSERT INTO messages(author_discord_id,author_name,body) VALUES(?,?,?)").bind(privateSession.id,name,body).run();
      return json({ok:true,id:r.meta.last_row_id},201);
    }
    if(url.pathname==="/api/requests" && request.method==="GET"){
      if(!isJudge)return json({error:"Judge permission required"},403);
      const {results}=await env.DB.prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT 100").all();return json({items:results||[]});
    }
    if(url.pathname==="/api/requests" && request.method==="POST"){
      let b;try{b=await request.json()}catch{return json({error:"Invalid JSON"},400)}
      const category=String(b.category||"عام").trim(),subject=String(b.subject||"").trim(),body=String(b.body||"").trim();
      if(!subject||!body||subject.length>160||body.length>3000)return json({error:"راجع بيانات الطلب"},400);
      const r=await env.DB.prepare("INSERT INTO requests(requester_discord_id,category,subject,body) VALUES(?,?,?,?)").bind(privateSession.id,category,subject,body).run();
      return json({ok:true,id:r.meta.last_row_id},201);
    }
    if(url.pathname==="/api/tasks" && request.method==="GET"){
      const {results}=await env.DB.prepare("SELECT * FROM ministry_tasks ORDER BY created_at DESC LIMIT 100").all();return json({items:results||[]});
    }
    if(url.pathname==="/api/tasks" && request.method==="POST"){
      if(!isJudge)return json({error:"Judge permission required"},403);
      let b;try{b=await request.json()}catch{return json({error:"Invalid JSON"},400)}
      const title=String(b.title||"").trim(),details=String(b.details||"").trim(),assigned=String(b.assigned_to||"").trim()||null,due=String(b.due_at||"").trim()||null;
      if(!title||title.length>180||details.length>3000)return json({error:"راجع بيانات المهمة"},400);
      const r=await env.DB.prepare("INSERT INTO ministry_tasks(title,details,assigned_to,created_by,due_at) VALUES(?,?,?,?,?)").bind(title,details,assigned,privateSession.id,due).run();
      return json({ok:true,id:r.meta.last_row_id},201);
    }
    if(url.pathname==="/api/lawyers" && request.method==="GET"){
      const {results}=await env.DB.prepare("SELECT discord_id,display_name,rank,points,status,notes,updated_at FROM lawyers ORDER BY points DESC,display_name ASC").all();return json({items:results||[]});
    }
    if(url.pathname==="/api/lawyers" && request.method==="POST"){
      if(!isJudge)return json({error:"Judge permission required"},403);
      let b;try{b=await request.json()}catch{return json({error:"Invalid JSON"},400)}
      const id=String(b.discord_id||"").trim(),name=String(b.display_name||"").trim(),rank=String(b.rank||"محامٍ").trim(),points=Number(b.points||0),notes=String(b.notes||"").trim();
      if(!id||!name||name.length>100||!Number.isInteger(points)||points<0||points>10000)return json({error:"راجع بيانات المحامي"},400);
      await env.DB.prepare("INSERT INTO lawyers(discord_id,display_name,rank,points,notes) VALUES(?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET display_name=excluded.display_name,rank=excluded.rank,points=excluded.points,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP").bind(id,name,rank,points,notes).run();
      return json({ok:true},201);
    }

    if(url.pathname==="/" && request.method==="GET") {
      const reason=url.searchParams.get("login")||"";
      const messages={
        invalid:"تعذر التحقق من جلسة Discord (state). غالباً المتصفح لم يحفظ ملف الارتباط أو انتهت صلاحيته.",
        "no-access":"تم تسجيل دخول Discord، لكن حسابك لا يحمل رتبة عضو وزارة العدل المطلوبة.",
        "session-invalid":"رجعنا من Discord لكن ملف الجلسة لم يصل أو لم يتم التحقق منه.",
        failed:"Discord رفض إكمال تسجيل الدخول. حاول مرة أخرى."
      };
      const message=messages[reason]||"بوابة تسجيل الدخول لوزارة العدل — Arab City RP.";
      const html='<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>وزارة العدل</title><body style="margin:0;background:#0a111a;color:#f2f0e9;font-family:Tahoma,Arial;min-height:100vh;display:grid;place-items:center"><main style="max-width:560px;margin:24px;padding:32px;background:#111c29;border:1px solid #344456"><div style="color:#c7a66b;font-size:12px;letter-spacing:2px">ARAB CITY RP · MINISTRY OF JUSTICE</div><h1 style="font-size:27px">بوابة وزارة العدل</h1><p style="color:#b9c3cf;line-height:2">'+message+'</p><a href="/auth/login" style="display:inline-block;margin-top:14px;padding:12px 22px;background:#b28f55;color:#101722;text-decoration:none">إعادة محاولة تسجيل الدخول</a></main></body></html>';
      return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    }
    if(url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
    if(url.pathname === "/") return redirect("/auth/login");
    return new Response("Not found", {status:404, headers:{"content-type":"text/plain; charset=utf-8"}});
  }
};
