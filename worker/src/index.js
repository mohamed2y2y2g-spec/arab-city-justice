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
function redirect(url, headers={}) { return new Response(null,{status:302,headers:{Location:url,...headers}}); }

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
      const state=url.searchParams.get("state"), saved=cookie(request,"acj_oauth_state"), code=url.searchParams.get("code");
      const clearState=clearCookie("acj_oauth_state");
      if(!state || !saved || state!==saved || !code) return redirect("/?login=invalid",{"Set-Cookie":clearState});
      if(!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_REDIRECT_URI || !env.SESSION_SECRET) return json({error:"OAuth secrets are not configured."},503,{"Set-Cookie":clearState});
      const form=new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:"authorization_code",code,redirect_uri:env.DISCORD_REDIRECT_URI});
      const tokenRes=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});
      if(!tokenRes.ok) return redirect("/?login=failed",{"Set-Cookie":clearState});
      const token=await tokenRes.json();
      const userRes=await discordFetch("/users/@me",token.access_token);
      if(!userRes.ok) return redirect("/?login=failed",{"Set-Cookie":clearState});
      const user=await userRes.json();
      const memberRes=await discordFetch("/users/@me/guilds/"+env.DISCORD_GUILD_ID+"/member",token.access_token);
      if(!memberRes.ok) return redirect("/?login=not-member",{"Set-Cookie":clearState});
      const member=await memberRes.json();
      const roles=Array.isArray(member.roles)?member.roles:[];
      if(!roles.includes(env.MINISTRY_ROLE_ID)) return redirect("/?login=no-access",{"Set-Cookie":clearState});
      const session=await seal({id:user.id,username:user.username,global_name:user.global_name||user.username,avatar:user.avatar||null,roles,exp:Date.now()+6*60*60*1000},env.SESSION_SECRET);
      return redirect("/members.html",{"Set-Cookie":[setCookie("acj_session",session,21600),clearState].join(", ")});
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
      if(!session.roles.includes(env.JUDGE_ROLE_ID)) return json({error:"Insufficient permissions"},403);
      let body; try { body=await request.json(); } catch { return json({error:"Invalid JSON"},400); }
      const title=String(body.title||"").trim(), text=String(body.body||"").trim();
      if(!title || !text || title.length>160 || text.length>10000) return json({error:"Title/body is missing or too long"},400);
      const result=await env.DB.prepare("INSERT INTO circulars (title,body,author_discord_id) VALUES (?,?,?)").bind(title,text,session.id).run();
      await env.DB.prepare("INSERT INTO audit_log (actor_discord_id,action,target_type,target_id) VALUES (?,?,?,?)").bind(session.id,"publish_circular","circular",String(result.meta.last_row_id)).run();
      return json({ok:true,id:result.meta.last_row_id},201);
    }

    if(url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
    return env.ASSETS.fetch(request);
  }
};
