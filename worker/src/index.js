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
        let roles=[];
        if(memberRes.ok) {
          const member=await memberRes.json();
          roles=Array.isArray(member.roles)?member.roles:[];
        } else if(memberRes.status===404) {
          // Discord account is valid but is not a member of this server.
          // Public portal access is still allowed; internal APIs remain role-protected.
          roles=[];
        } else {
          console.error("Discord guild member lookup rejected",memberRes.status,(await memberRes.text()).slice(0,300));
          return json({error:"Discord guild membership lookup failed.",stage:oauthStage,status:memberRes.status},502,{"Set-Cookie":clearState});
        }
        oauthStage="check-ministry-role";
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
      const html=`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#172630"><title>وزارة العدل | Arab City RP</title><link rel="stylesheet" href="/style.css"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet"></head><body class="public-home">
<header class="topbar"><a class="brand" href="/"><span class="mark">ع</span><span>وزارة العدل<small>ARAB CITY RP</small></span></a><nav><a href="#services">الخدمات</a><a href="#circulars">التعاميم</a><a href="#about">عن البوابة</a><a class="login" href="/auth/login">دخول الأعضاء</a></nav></header>
<main><section class="hero public-hero"><div class="hero-inner"><div class="eyebrow">ARAB CITY RP <span> / </span> MINISTRY OF JUSTICE</div><div class="hero-rule"></div><h1>العدالة،<br><em>بإجراءات واضحة.</em></h1><p class="lead">بوابة وزارة العدل — مساحة موحدة للاطلاع على الخدمات والقرارات، والوصول إلى الأدوات المخصصة لأعضاء الوزارة.</p><div class="hero-actions"><a class="hero-cta" href="/members.html">استكشف البوابة <span>←</span></a><a class="hero-secondary" href="/auth/login">تسجيل دخول الأعضاء</a></div><div class="hero-foot"><span>01 — بوابة إلكترونية عامة</span><span>ARAB CITY ROLEPLAY</span></div></div><div class="hero-ornament"><div class="ornament-ring"></div><div class="ornament-mark">ع</div><div class="ornament-caption">MINISTRY<br>OF JUSTICE</div></div></section>
<section class="section public-intro" id="about"><div class="section-kicker">01 / THE PORTAL</div><div class="intro-grid"><h2>منصة واحدة.<br><span>خدمات أكثر وضوحاً.</span></h2><p>تمثل البوابة نقطة الوصول الرقمية لوزارة العدل في Arab City RP. يمكن لأي زائر تصفح المعلومات العامة، بينما تتطلب أدوات العمل الداخلي تسجيل الدخول والتحقق من عضوية الوزارة.</p></div></section>
<section class="section public-services" id="services"><div class="section-head"><div><div class="section-kicker">02 / SERVICES</div><h2>الخدمات الإلكترونية</h2></div><p>الأقسام والخدمات المتاحة عبر البوابة.</p></div><div class="service-grid"><a class="service-card" href="/members.html"><span class="service-no">01</span><div class="service-icon">▤</div><h3>التعاميم والقرارات</h3><p>متابعة ما يصدر عن الوزارة من تعاميم وتوجيهات رسمية.</p><b>استعراض القسم ←</b></a><a class="service-card" href="/members.html"><span class="service-no">02</span><div class="service-icon">⚖</div><h3>الخدمات القضائية</h3><p>مساحة منظمة للخدمات والإجراءات المرتبطة بالشؤون القضائية.</p><b>استعراض البوابة ←</b></a><a class="service-card" href="/auth/login"><span class="service-no">03</span><div class="service-icon">♙</div><h3>بوابة أعضاء الوزارة</h3><p>أدوات العمل الداخلي والمحادثات المخصصة للأعضاء المعتمدين.</p><b>دخول الأعضاء ←</b></a></div></section>
<section class="section public-circulars" id="circulars"><div class="section-head"><div><div class="section-kicker">03 / OFFICIAL PUBLICATIONS</div><h2>التعاميم الرسمية</h2></div><a class="section-link" href="/members.html">عرض جميع التعاميم ←</a></div><div class="notice"><div class="notice-symbol">§</div><div><strong>المصدر الرسمي لقرارات الوزارة</strong><p>تُنشر التعاميم والتوجيهات المعتمدة من خلال سجل التعاميم داخل البوابة.</p></div></div></section>
<section class="public-access" ><div><div class="section-kicker">04 / MEMBER ACCESS</div><h2>مساحة مخصصة<br>لأعضاء الوزارة.</h2><p>تسجيل الدخول اختياري لتصفح الموقع. أما الأدوات الداخلية والمحادثات فتتطلب حساب Discord يحمل رتبة عضوية الوزارة.</p></div><a href="/auth/login">تسجيل دخول الأعضاء <span>↗</span></a></section></main>
<footer class="public-footer"><a class="brand" href="/"><span class="mark">ع</span><span>وزارة العدل<small>ARAB CITY RP</small></span></a><div>بوابة وزارة العدل · جميع الحقوق محفوظة</div><span class="footer-en">MINISTRY OF JUSTICE</span></footer>
<style>
.public-home{background:#f3f1eb;color:#202a32;font-family:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif}.public-home .topbar{height:88px;padding:0 8vw}.public-home .brand{font-size:15px}.public-home .brand small{font-size:9px}.public-home nav{gap:34px}.public-home nav a{font-family:inherit;font-size:12px;color:#69757a}.public-home nav a:hover{color:#a9854d}.public-home nav .login{border:1px solid #b18e56;color:#84683d;padding:10px 18px}.public-hero{min-height:620px;padding:92px 12vw 38px;position:relative;overflow:hidden;display:flex;align-items:center;background:linear-gradient(112deg,#172630 0%,#22353e 58%,#34484b 100%);border:0}.hero-inner{position:relative;z-index:2;max-width:680px}.public-hero .eyebrow{font-size:10px;letter-spacing:2.5px;color:#d0b98d}.hero-rule{width:72px;height:1px;background:#b18e56;margin:25px 0}.public-hero h1{font-size:clamp(58px,7.5vw,100px);line-height:1.16;letter-spacing:-3px;font-weight:600;margin:0 0 24px;color:#f7f4ec}.public-hero h1 em{font-style:normal;color:#d7c39e}.public-hero .lead{color:#c3ceca;font-size:16px;line-height:2;max-width:560px}.hero-actions{display:flex;gap:24px;align-items:center;margin-top:32px}.hero-cta{display:inline-flex;gap:28px;align-items:center;padding:14px 22px;background:#c0a16d;color:#172630;text-decoration:none;font-size:13px;font-weight:600;transition:transform .25s,background .25s}.hero-cta:hover{transform:translateY(-3px);background:#d6bd91}.hero-secondary{color:#e7e6df;text-decoration:none;font-size:12px;border-bottom:1px solid #819094;padding:8px 0}.public-hero .hero-foot{display:flex;gap:35px;margin-top:90px;color:#9caaa7;font-size:9px;letter-spacing:1px}.hero-ornament{position:absolute;left:12%;top:50%;transform:translateY(-48%);width:330px;height:330px;border:1px solid #ffffff20;border-radius:50%;display:grid;place-items:center;opacity:.8}.ornament-ring{position:absolute;inset:28px;border:1px solid #c0a16d66;border-radius:50%;box-shadow:0 0 0 18px #ffffff05,0 0 0 54px #ffffff03}.ornament-mark{font-size:130px;color:#d6bd91;font-weight:400}.ornament-caption{position:absolute;bottom:-35px;left:50%;transform:translateX(-50%);font:9px/1.8 Arial;letter-spacing:3px;color:#9eaaa5;text-align:center}.public-home .section{padding:100px 12vw;border-color:#e2ded5}.section-kicker{font:10px Arial;letter-spacing:2px;color:#a07d48}.intro-grid{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center;margin-top:25px}.intro-grid h2,.section-head h2{font-size:42px;line-height:1.5;font-weight:500;margin:0;color:#1d2b33}.intro-grid h2 span{color:#a9854d}.intro-grid p{color:#69757a;line-height:2.2;font-size:15px;max-width:560px}.section-head{display:flex;align-items:end;justify-content:space-between;margin-bottom:34px}.section-head h2{font-size:34px;margin-top:10px}.section-head>p{color:#788287;font-size:13px}.service-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.service-card{display:block;position:relative;padding:30px 27px 26px;min-height:260px;background:#fffefa;border:1px solid #e1ddd3;text-decoration:none;color:#24323a;transition:transform .35s,box-shadow .35s,border-color .35s}.service-card:hover{transform:translateY(-8px);border-color:#c4ad83;box-shadow:0 22px 50px #17263012}.service-no{position:absolute;left:24px;top:23px;font:11px Arial;color:#b3a17e}.service-icon{font-size:27px;color:#a9854d;margin:12px 0 22px}.service-card h3{font-size:18px;margin:0 0 10px}.service-card p{font-size:12px;line-height:2;color:#758085;min-height:50px}.service-card b{display:block;margin-top:20px;font-size:11px;color:#927344;font-weight:500}.section-link{font-size:12px;color:#927344;text-decoration:none;border-bottom:1px solid #c9b895;padding-bottom:8px}.notice{display:flex;align-items:center;gap:25px;padding:27px 30px;border:1px solid #e1ddd3;background:#fffefa;color:#27343a}.notice-symbol{width:55px;height:55px;display:grid;place-items:center;border:1px solid #d8c8aa;color:#a9854d;font:30px Georgia}.notice strong{font-size:15px}.notice p{font-size:12px;color:#788287;margin:8px 0 0}.public-access{padding:78px 12vw;background:#e9e5db;display:flex;justify-content:space-between;align-items:center;gap:30px}.public-access h2{font-size:38px;line-height:1.45;margin:10px 0;color:#1e2d34}.public-access p{max-width:600px;color:#68747a;line-height:2;font-size:13px}.public-access>a{background:#1d3039;color:#f4f0e7;text-decoration:none;padding:15px 22px;font-size:12px;white-space:nowrap}.public-access>a span{margin-right:24px;color:#d6bd91}.public-footer{display:flex;align-items:center;justify-content:space-between;padding:30px 8vw;background:#172630;color:#aeb9b5;font-size:10px}.public-footer .brand{color:#f1eee5}.public-footer .mark{border-color:#b99a68;color:#d6bd91}.public-footer .brand small{color:#d6bd91}.footer-en{font:9px Arial;letter-spacing:2px;color:#7f9290}
@keyframes heroReveal{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}@keyframes ornamentTurn{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.hero-inner{animation:heroReveal .9s cubic-bezier(.2,.7,.2,1) both}.hero-ornament{animation:heroReveal 1.2s .15s both}.ornament-ring{animation:ornamentTurn 65s linear infinite}.public-intro,.public-services,.public-circulars{animation:heroReveal .8s both}.service-card:nth-child(2){transition-delay:.04s}.service-card:nth-child(3){transition-delay:.08s}
@media(max-width:900px){.hero-ornament{left:-80px;opacity:.28}.public-hero{padding:85px 8vw 35px}.public-home .section{padding:75px 8vw}.service-grid{grid-template-columns:1fr 1fr}.intro-grid{gap:25px}.public-access{padding:65px 8vw}}@media(max-width:620px){.public-home .topbar{padding:0 18px;height:72px}.public-home nav{gap:12px}.public-home nav a:not(.login){display:none}.public-home nav .login{font-size:10px;padding:8px 10px}.public-hero{min-height:590px;padding:75px 25px 30px}.public-hero h1{font-size:59px}.public-hero .lead{font-size:14px}.public-hero .hero-foot{margin-top:65px;gap:15px;flex-direction:column}.hero-ornament{width:250px;height:250px;left:-125px;top:48%}.ornament-mark{font-size:95px}.intro-grid{grid-template-columns:1fr;gap:12px}.intro-grid h2,.section-head h2{font-size:32px}.section-head{align-items:flex-start;gap:15px;flex-direction:column}.service-grid{grid-template-columns:1fr}.service-card{min-height:220px}.public-access{flex-direction:column;align-items:flex-start;padding:55px 25px}.public-access h2{font-size:32px}.public-footer{padding:25px;gap:18px;align-items:flex-start;flex-direction:column}.footer-en{display:none}}
@media(prefers-reduced-motion:reduce){.public-home *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style></body></html>`;
      return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    }
    if(url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
    if(url.pathname === "/") return redirect("/auth/login");
    return new Response("Not found", {status:404, headers:{"content-type":"text/plain; charset=utf-8"}});
  }
};
