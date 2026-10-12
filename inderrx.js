/**
 * KCSE Papers Telegram Bot for Cloudflare Workers
 * One-file deployment. Requires KV binding BOT_KV.
 * Variables/secrets: BOT_TOKEN, ADMIN_ID, PAYMENT_PROVIDER_TOKEN, optional WEBHOOK_SECRET.
 * Telegram native payments require a payment provider configured in BotFather that supports KES.
 */
const DB_KEY = 'kcse:db:v2';
const SESS = 'kcse:sess:';
const ORDER = 'kcse:order:';
const PRICE_KES = 1000;
const CURRENCY = 'KES';
const MAX_FILES = 20;
const TYPES = { exam_paper: 'Exam Paper', marking_scheme: 'Marking Scheme', revision_notes: 'Revision Notes' };
const DEFAULTS = [
  ['English',['Paper 1','Paper 2','Paper 3']],['Kiswahili',['Paper 1','Paper 2','Paper 3']],
  ['Mathematics',['Paper 1','Paper 2']],['Biology',['Paper 1','Paper 2','Paper 3']],
  ['Chemistry',['Paper 1','Paper 2','Paper 3']],['Physics',['Paper 1','Paper 2','Paper 3']],
  ['History & Government',['Paper 1','Paper 2']],['Geography',['Paper 1','Paper 2']],
  ['Christian Religious Education',['Paper 1','Paper 2']],['Islamic Religious Education',['Paper 1','Paper 2']],
  ['Agriculture',['Paper 1','Paper 2']],['Business Studies',['Paper 1','Paper 2']],['Computer Studies',['Paper 1','Paper 2','Paper 3']]
];
const id = () => crypto.randomUUID().replaceAll('-','').slice(0,16);
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const kb = rows => ({ inline_keyboard: rows });
const b = (text, callback_data) => ({ text, callback_data });
const isAdmin = (env, uid) => !!env.ADMIN_ID && String(uid) === String(env.ADMIN_ID);

async function tg(env, method, data) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(data)
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.description || `Telegram ${method} failed`);
  return out.result;
}
async function send(env, chat, text, reply_markup, extra={}) {
  return tg(env,'sendMessage',{chat_id:chat,text,parse_mode:'HTML',...(reply_markup?{reply_markup}:{}),...extra});
}
async function edit(env, chat, mid, text, reply_markup) {
  try { return await tg(env,'editMessageText',{chat_id:chat,message_id:mid,text,parse_mode:'HTML',...(reply_markup?{reply_markup}:{})}); }
  catch(e) { if (!String(e.message).includes('message is not modified')) throw e; }
}
async function ack(env, q) { try { await tg(env,'answerCallbackQuery',{callback_query_id:q}); } catch {} }
async function dbGet(env) {
  let db = await env.BOT_KV.get(DB_KEY,'json');
  if (!db || !Array.isArray(db.subjects) || !Array.isArray(db.resources)) {
    db = {version:2,subjects:DEFAULTS.map(([name,papers])=>({id:id(),name,papers:papers.map(name=>({id:id(),name}))})),resources:[]};
    await dbPut(env,db);
  }
  return db;
}
async function dbPut(env,db) { await env.BOT_KV.put(DB_KEY,JSON.stringify(db)); }
async function getSession(env,uid) { return (await env.BOT_KV.get(SESS+uid,'json')) || {}; }
async function setSession(env,uid,s) { await env.BOT_KV.put(SESS+uid,JSON.stringify(s),{expirationTtl:86400}); }
async function clearSession(env,uid) { await env.BOT_KV.delete(SESS+uid); }
const findSubject = (db,sid) => db.subjects.find(s=>s.id===sid);
const findPaper = (s,pid) => s?.papers?.find(p=>p.id===pid);
const resources = (db,sid,pid,type) => db.resources.filter(r=>r.subjectId===sid&&r.paperId===pid&&(!type||r.type===type)&&r.files?.length);
const visibleSubjects = db => db.subjects.filter(s=>s.papers.some(p=>resources(db,s.id,p.id).length));

async function home(env,chat,mid) {
  const text='<b>KCSE PAPERS</b>\nYour examination revision library.\n\nEach resource costs <b>KSh 1,000</b>. Payment is required before delivery.';
  const menu=kb([[b('Browse Subjects','stu:subjects')],[b('Help','stu:help')],...(isAdmin(env,chat)?[[b('Admin Panel','adm:home')]]:[])]);
  return mid?edit(env,chat,mid,text,menu):send(env,chat,text,menu);
}
async function subjectMenu(env,chat,mid) {
  const db=await dbGet(env), ss=visibleSubjects(db);
  const rows=ss.map(s=>[b(s.name,'stu:sub:'+s.id)]); rows.push([b('Main Menu','stu:home')]);
  const text=ss.length?'<b>Choose a subject</b>':'No resources are published yet. Please check again later.';
  return mid?edit(env,chat,mid,text,kb(rows)):send(env,chat,text,kb(rows));
}
async function paperMenu(env,chat,mid,sid) {
  const db=await dbGet(env),s=findSubject(db,sid); if(!s) return subjectMenu(env,chat,mid);
  const ps=s.papers.filter(p=>resources(db,s.id,p.id).length);
  const rows=ps.map(p=>[b(p.name,`stu:paper:${s.id}:${p.id}`)]); rows.push([b('Back','stu:subjects'),b('Main Menu','stu:home')]);
  return edit(env,chat,mid,`<b>${esc(s.name)}</b>\nChoose a paper.`,kb(rows));
}
async function typeMenu(env,chat,mid,sid,pid) {
  const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid); if(!s||!p) return subjectMenu(env,chat,mid);
  const rows=Object.entries(TYPES).filter(([t])=>resources(db,sid,pid,t).length).map(([t,label])=>[b(`${label} (${resources(db,sid,pid,t).length})`,`stu:type:${sid}:${pid}:${t}`)]);
  rows.push([b('Back',`stu:sub:${sid}`),b('Main Menu','stu:home')]);
  return edit(env,chat,mid,`<b>${esc(s.name)} — ${esc(p.name)}</b>\nSelect a resource type.`,kb(rows));
}
async function resourceMenu(env,chat,mid,sid,pid,type) {
  const db=await dbGet(env), rs=resources(db,sid,pid,type);
  const rows=rs.map(r=>[b(`${r.title} — KSh ${PRICE_KES}`,`stu:buy:${r.id}`)]);
  rows.push([b('Back',`stu:paper:${sid}:${pid}`),b('Main Menu','stu:home')]);
  return edit(env,chat,mid,`<b>${esc(TYPES[type]||'Resources')}</b>\nChoose a resource to purchase.`,kb(rows));
}
async function createInvoice(env,chat,uid,rid) {
  if (!env.PAYMENT_PROVIDER_TOKEN) return send(env,chat,'Payments are not configured yet. The administrator must add the PAYMENT_PROVIDER_TOKEN secret in Cloudflare and configure a payment provider in BotFather.');
  const db=await dbGet(env),r=db.resources.find(x=>x.id===rid&&x.files?.length);
  if(!r) return send(env,chat,'Sorry, this resource is no longer available.');
  const orderId=id(), payload=`kcse:${orderId}`;
  const order={id:orderId,payload,userId:String(uid),chatId:String(chat),resourceId:rid,amount:PRICE_KES*100,currency:CURRENCY,status:'pending',createdAt:Date.now()};
  await env.BOT_KV.put(ORDER+orderId,JSON.stringify(order),{expirationTtl:604800});
  try {
    await tg(env,'sendInvoice',{
      chat_id:chat,title:String(r.title).slice(0,32),description:`${TYPES[r.type]||'KCSE resource'} — one resource`,payload,
      provider_token:env.PAYMENT_PROVIDER_TOKEN,currency:CURRENCY,
      prices:[{label:String(r.title).slice(0,32),amount:PRICE_KES*100}],
      start_parameter:`kcse_${orderId}`,need_name:false,need_phone_number:false,need_email:false,
      is_flexible:false
    });
  } catch(e) {
    await env.BOT_KV.delete(ORDER+orderId);
    console.error('Invoice error:',e.message);
    await send(env,chat,'Telegram could not create the invoice. Check that your configured payment provider supports KES and that PAYMENT_PROVIDER_TOKEN is correct.');
  }
}
async function deliver(env,chat,rid) {
  const db=await dbGet(env),r=db.resources.find(x=>x.id===rid&&x.files?.length);
  if(!r) return send(env,chat,'Payment was received, but the resource is unavailable. Please contact the administrator.');
  await send(env,chat,`<b>Payment confirmed.</b>\nDelivering: ${esc(r.title)}`);
  try {
    if(r.files.length===1&&r.files[0].kind==='document') return await tg(env,'sendDocument',{chat_id:chat,document:r.files[0].fileId});
    if(r.files.every(f=>f.kind==='photo')) {
      for(let i=0;i<r.files.length;i+=10){const batch=r.files.slice(i,i+10);if(batch.length===1) await tg(env,'sendPhoto',{chat_id:chat,photo:batch[0].fileId});else await tg(env,'sendMediaGroup',{chat_id:chat,media:batch.map(f=>({type:'photo',media:f.fileId}))});}
    } else {
      for(const f of r.files){if(f.kind==='document') await tg(env,'sendDocument',{chat_id:chat,document:f.fileId});else await tg(env,'sendPhoto',{chat_id:chat,photo:f.fileId});}
    }
  } catch(e){console.error('Delivery error:',e.message);await send(env,chat,'Your payment was confirmed, but delivery failed. Contact the administrator with your payment receipt.');}
}

async function adminHome(env,chat,mid) {
  const text='<b>Admin Panel</b>\nManage the catalogue and upload resources here in Telegram.\n\nCommands:\n<code>/addsubject Subject name</code>\n<code>/addpaper Subject name | Paper 1</code>\n<code>/upload Subject | Paper | exam_paper | Optional title</code>\nSend PDF/document or up to 20 images, then use <code>/finish</code>.\n<code>/cancel</code> cancels a pending upload.';
  const menu=kb([[b('View Catalogue','adm:list')],[b('Main Menu','stu:home')]]);
  return mid?edit(env,chat,mid,text,menu):send(env,chat,text,menu);
}
async function listAdmin(env,chat,mid) {
  const db=await dbGet(env); const rows=db.subjects.map(s=>[b(`${s.name} (${s.papers.length} papers)`,'adm:subject:'+s.id)]);
  rows.push([b('Admin Home','adm:home')]);
  return edit(env,chat,mid,'<b>Catalogue</b>\nSelect a subject to view its papers.',kb(rows));
}
async function adminSubject(env,chat,mid,sid) {
  const db=await dbGet(env),s=findSubject(db,sid);if(!s)return listAdmin(env,chat,mid);
  const rows=s.papers.map(p=>[b(p.name,`adm:paper:${s.id}:${p.id}`)]);
  rows.push([b('Back','adm:list'),b('Admin Home','adm:home')]);
  return edit(env,chat,mid,`<b>${esc(s.name)}</b>\nPapers: ${s.papers.length}`,kb(rows));
}
async function adminPaper(env,chat,mid,sid,pid) {
  const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid);if(!s||!p)return listAdmin(env,chat,mid);
  const rs=resources(db,sid,pid);
  const rows=rs.map(r=>[b(`${TYPES[r.type]||r.type}: ${r.title}`,'adm:resource:'+r.id)]);
  rows.push([b('Back',`adm:subject:${sid}`),b('Admin Home','adm:home')]);
  return edit(env,chat,mid,`<b>${esc(s.name)} — ${esc(p.name)}</b>\nPublished resources: ${rs.length}\n\nTo upload, send:\n<code>/upload ${esc(s.name)} | ${esc(p.name)} | exam_paper | Title</code>`,kb(rows));
}
async function beginUpload(env,chat,uid,args) {
  const parts=args.split('|').map(x=>x.trim());
  if(parts.length<3) return send(env,chat,'Use this format:\n<code>/upload Subject | Paper 1 | exam_paper | Optional title</code>\nTypes: <code>exam_paper</code>, <code>marking_scheme</code>, <code>revision_notes</code>.');
  const [subjectName,paperName,type,...titleParts]=parts;
  if(!TYPES[type]) return send(env,chat,'Unknown resource type. Use exam_paper, marking_scheme or revision_notes.');
  const db=await dbGet(env),s=db.subjects.find(x=>x.name.toLowerCase()===subjectName.toLowerCase()),p=s?.papers.find(x=>x.name.toLowerCase()===paperName.toLowerCase());
  if(!s||!p) return send(env,chat,'Subject or paper not found. Add it first with /addsubject or /addpaper. Names must match the catalogue.');
  const title=titleParts.join(' | ')||`${s.name} — ${p.name} — ${TYPES[type]} ${resources(db,s.id,p.id,type).length+1}`;
  await setSession(env,uid,{mode:'upload',subjectId:s.id,paperId:p.id,type,title,files:[]});
  return send(env,chat,`<b>Upload started</b>\nResource: ${esc(title)}\nSend one PDF/document or up to ${MAX_FILES} images. When finished, send <code>/finish</code>. Send <code>/cancel</code> to discard this upload.`);
}
async function finishUpload(env,chat,uid) {
  const sess=await getSession(env,uid);if(sess.mode!=='upload')return send(env,chat,'There is no active upload.');
  if(!sess.files?.length)return send(env,chat,'No files received yet. Send a PDF/document or images first.');
  const db=await dbGet(env);db.resources.push({id:id(),subjectId:sess.subjectId,paperId:sess.paperId,type:sess.type,title:sess.title,files:sess.files,createdAt:Date.now()});
  await dbPut(env,db);await clearSession(env,uid);
  return send(env,chat,`Published successfully: <b>${esc(sess.title)}</b>\nFiles: ${sess.files.length}\nPrice: KSh ${PRICE_KES} per resource.`);
}
async function handleAdminMessage(env,msg) {
  const chat=msg.chat.id,uid=msg.from.id,text=String(msg.text||'').trim();
  let sess=await getSession(env,uid);
  if(text==='/cancel'){await clearSession(env,uid);return send(env,chat,'Pending action cancelled.');}
  if(sess.mode==='upload'&&(msg.document||msg.photo)){
    if(msg.document){if(sess.files.length) return send(env,chat,'This upload already contains files. Start a new resource for a separate document.');sess.files.push({kind:'document',fileId:msg.document.file_id,name:msg.document.file_name||'document'});}
    else {if(sess.files.length>=MAX_FILES)return send(env,chat,`Limit reached: ${MAX_FILES} images per resource.`);const photo=msg.photo[msg.photo.length-1];sess.files.push({kind:'photo',fileId:photo.file_id});}
    await setSession(env,uid,sess);return send(env,chat,`Received file ${sess.files.length}. ${sess.files.length>=MAX_FILES?'Image limit reached. Send /finish to publish.':'Send more files or /finish to publish.'}`);
  }
  if(text==='/finish')return finishUpload(env,chat,uid);
  if(text.startsWith('/addsubject ')){
    const name=text.slice(12).trim();if(!name)return send(env,chat,'Provide a subject name.');const db=await dbGet(env);
    if(db.subjects.some(s=>s.name.toLowerCase()===name.toLowerCase()))return send(env,chat,'That subject already exists.');
    db.subjects.push({id:id(),name,papers:[]});await dbPut(env,db);return send(env,chat,`Added subject: <b>${esc(name)}</b>`);
  }
  if(text.startsWith('/addpaper ')){
    const [subjectName,paperName]=text.slice(10).split('|').map(x=>x.trim());if(!subjectName||!paperName)return send(env,chat,'Use: <code>/addpaper Subject name | Paper 1</code>');
    const db=await dbGet(env),s=db.subjects.find(x=>x.name.toLowerCase()===subjectName.toLowerCase());if(!s)return send(env,chat,'Subject not found. Use /addsubject first.');
    if(s.papers.some(p=>p.name.toLowerCase()===paperName.toLowerCase()))return send(env,chat,'That paper already exists.');
    s.papers.push({id:id(),name:paperName});await dbPut(env,db);return send(env,chat,`Added paper <b>${esc(paperName)}</b> under ${esc(s.name)}.`);
  }
  if(text.startsWith('/upload '))return beginUpload(env,chat,uid,text.slice(8));
  if(text==='/admin')return adminHome(env,chat);
  if(text==='/start')return home(env,chat);
  if(sess.mode==='upload')return send(env,chat,'Upload a PDF/document or image, then send /finish. Use /cancel to discard.');
  return send(env,chat,'Admin commands:\n<code>/addsubject Subject name</code>\n<code>/addpaper Subject name | Paper 1</code>\n<code>/upload Subject | Paper | exam_paper | Optional title</code>\n<code>/finish</code>\n<code>/cancel</code>');
}

async function handleCallback(env,q) {
  await ack(env,q.id);const msg=q.message,chat=msg.chat.id,mid=msg.message_id,uid=q.from.id,data=q.data||'';
  if(data.startsWith('adm:')&&!isAdmin(env,uid))return send(env,chat,'Access denied.');
  if(data==='stu:home')return home(env,chat,mid);
  if(data==='stu:subjects')return subjectMenu(env,chat,mid);
  if(data==='stu:help')return edit(env,chat,mid,'<b>How it works</b>\n1. Choose a subject, paper and resource.\n2. Pay KSh 1,000 through the Telegram invoice.\n3. The bot verifies Telegram payment and sends the resource.\n\nIf payment fails, do not pay again until you check your payment status.',kb([[b('Browse Subjects','stu:subjects')],[b('Main Menu','stu:home')]]));
  if(data.startsWith('stu:sub:'))return paperMenu(env,chat,mid,data.split(':')[2]);
  if(data.startsWith('stu:paper:')){const [, ,sid,pid]=data.split(':');return typeMenu(env,chat,mid,sid,pid);}
  if(data.startsWith('stu:type:')){const [, ,sid,pid,type]=data.split(':');return resourceMenu(env,chat,mid,sid,pid,type);}
  if(data.startsWith('stu:buy:'))return createInvoice(env,chat,uid,data.split(':')[2]);
  if(data==='adm:home')return adminHome(env,chat,mid);
  if(data==='adm:list')return listAdmin(env,chat,mid);
  if(data.startsWith('adm:subject:'))return adminSubject(env,chat,mid,data.split(':')[2]);
  if(data.startsWith('adm:paper:')){const [, ,sid,pid]=data.split(':');return adminPaper(env,chat,mid,sid,pid);}
  if(data.startsWith('adm:resource:')){const rid=data.split(':')[2],db=await dbGet(env),r=db.resources.find(x=>x.id===rid);if(!r)return send(env,chat,'Resource not found.');return send(env,chat,`Resource: ${esc(r.title)}\nType: ${esc(TYPES[r.type]||r.type)}\nFiles: ${r.files.length}\nTo remove it, use the KV catalogue editor or ask for the delete-command extension.`);}
}

async function handleUpdate(env,update) {
  if(update.pre_checkout_query){
    const q=update.pre_checkout_query;let ok=false,error_message='This order is invalid or expired.';
    const match=String(q.invoice_payload||'').match(/^kcse:([a-zA-Z0-9]+)$/);
    if(match){const order=await env.BOT_KV.get(ORDER+match[1],'json');if(order&&order.status==='pending'&&String(order.userId)===String(q.from.id)&&order.amount===q.total_amount&&order.currency===q.currency){ok=true;}}
    return tg(env,'answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok,...(!ok?{error_message}:{})});
  }
  const msg=update.message;
  if(msg?.successful_payment){
    const sp=msg.successful_payment,match=String(sp.invoice_payload||'').match(/^kcse:([a-zA-Z0-9]+)$/);
    if(!match)return send(env,msg.chat.id,'Payment was received but its order could not be identified. Contact the administrator.');
    const key=ORDER+match[1],order=await env.BOT_KV.get(key,'json');
    if(!order||String(order.userId)!==String(msg.from.id)||sp.total_amount!==order.amount||sp.currency!==order.currency)return send(env,msg.chat.id,'Payment received, but order verification failed. Contact the administrator with your Telegram payment receipt.');
    if(order.status==='paid')return send(env,msg.chat.id,'This order was already processed.');
    order.status='paid';order.telegramChargeId=sp.telegram_payment_charge_id;order.providerChargeId=sp.provider_payment_charge_id;order.paidAt=Date.now();
    await env.BOT_KV.put(key,JSON.stringify(order),{expirationTtl:2592000});
    await deliver(env,msg.chat.id,order.resourceId);return;
  }
  if(update.callback_query)return handleCallback(env,update.callback_query);
  if(!msg)return;
  const uid=msg.from?.id,chat=msg.chat.id,text=String(msg.text||'').trim();
  if(isAdmin(env,uid))return handleAdminMessage(env,msg);
  if(text==='/start')return home(env,chat);
  const sess=await getSession(env,uid);
  if(sess.mode==='search'&&text){const db=await dbGet(env),term=text.toLowerCase();const found=db.resources.filter(r=>r.files?.length&&r.title.toLowerCase().includes(term)).slice(0,20);if(!found.length)return send(env,chat,'No matching resources found.');return send(env,chat,'Search results:\n'+found.map(r=>`• ${esc(r.title)} — KSh ${PRICE_KES}`).join('\n'));}
  if(text==='/help')return send(env,chat,'Use /start to browse KCSE papers. Each resource costs KSh 1,000.');
  if(text)return send(env,chat,'Use the menu to browse and purchase KCSE resources. Send /start to open the menu.');
}
export default {
  async fetch(request,env) {
    if(request.method==='GET')return new Response('KCSE Papers Bot is running.',{status:200});
    const url=new URL(request.url);if(request.method!=='POST'||url.pathname!='/telegram')return new Response('Not found',{status:404});
    if(!env.BOT_TOKEN||!env.ADMIN_ID||!env.BOT_KV)return new Response('Missing BOT_TOKEN, ADMIN_ID, or BOT_KV configuration.',{status:500});
    if(env.WEBHOOK_SECRET){const token=request.headers.get('X-Telegram-Bot-Api-Secret-Token');if(token!==env.WEBHOOK_SECRET)return new Response('Unauthorized',{status:401});}
    let update;try{update=await request.json();}catch{return new Response('Bad request',{status:400});}
    try{await handleUpdate(env,update);}catch(e){console.error('Update failed:',e.stack||e.message);}
    return new Response('OK',{status:200});
  }
};
