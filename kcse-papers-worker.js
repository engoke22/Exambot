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
// Exam dates (EAT). Papers with no date are hidden from students until the admin sets one with /setdate.
const SCHEDULE = {
  'English|Paper 1':'2026-11-02','English|Paper 2':'2026-11-03','English|Paper 3':'2026-11-04',
  'Chemistry|Paper 1':'2026-11-02','Chemistry|Paper 2':'2026-11-04',
  'Mathematics|Paper 1':'2026-11-03','Mathematics|Paper 2':'2026-11-09',
  'Kiswahili|Paper 1':'2026-11-05','Kiswahili|Paper 2':'2026-11-05','Kiswahili|Paper 3':'2026-11-09',
  'Christian Religious Education|Paper 1':'2026-11-10','Islamic Religious Education|Paper 1':'2026-11-10',
  'Christian Religious Education|Paper 2':'2026-11-11','Islamic Religious Education|Paper 2':'2026-11-11',
  'Biology|Paper 1':'2026-11-10','Biology|Paper 2':'2026-11-12','Biology|Paper 3':'2026-11-13',
  'History & Government|Paper 1':'2026-11-11','History & Government|Paper 2':'2026-11-12',
  'Physics|Paper 3':'2026-11-20'
};
const eatToday = () => new Date(Date.now()+3*3600*1000).toISOString().slice(0,10);
const paperDate = (db,s,p) => db.dates?.[p.id] || SCHEDULE[`${s.name}|${p.name}`] || null;
const fmtDate = d => new Date(d+'T00:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
// A paper opens at 00:00 EAT on its exam day. The admin always sees everything for testing.
const isOpen = (env,db,s,p,uid) => { if(isAdmin(env,uid)) return true; const d=paperDate(db,s,p); return !!d && d<=eatToday(); };
const openPapers = (env,db,s,uid) => s.papers.filter(p=>isOpen(env,db,s,p,uid));
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

async function home(env,chat,mid) {
  const text='<b>KCSE PAPERS</b>\nYour examination revision library.\n\nEach paper costs <b>KSh 1,000</b>. Subjects appear here on the day of their exam. Pay after choosing a paper and the bot sends everything uploaded for it.';
  const menu=kb([[b('Browse Subjects','stu:subjects')],[b('Help','stu:help')],...(isAdmin(env,chat)?[[b('Admin Panel','adm:home')]]:[])]);
  return mid?edit(env,chat,mid,text,menu):send(env,chat,text,menu);
}
async function subjectMenu(env,chat,mid) {
  const db=await dbGet(env), ss=db.subjects.filter(s=>openPapers(env,db,s,chat).length);
  const rows=ss.map(s=>[b(s.name,'stu:sub:'+s.id)]); rows.push([b('Main Menu','stu:home')]);
  const text=ss.length?'<b>Choose a subject</b>':'No exams are open yet. Each subject appears here on the day of its exam.';
  return mid?edit(env,chat,mid,text,kb(rows)):send(env,chat,text,kb(rows));
}
async function paperMenu(env,chat,mid,sid) {
  const db=await dbGet(env),s=findSubject(db,sid); if(!s) return subjectMenu(env,chat,mid);
  const ps=openPapers(env,db,s,chat);
  const rows=ps.map(p=>{const d=paperDate(db,s,p);return [b(d?`${p.name} — ${fmtDate(d)}`:p.name,`stu:paper:${s.id}:${p.id}`)];}); rows.push([b('Back','stu:subjects'),b('Main Menu','stu:home')]);
  return edit(env,chat,mid,`<b>${esc(s.name)}</b>\nChoose a paper. You will be asked to pay KSh ${PRICE_KES} after selecting it.`,kb(rows));
}
async function selectPaper(env,chat,uid,sid,pid) {
  const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid);
  if(!s||!p) return send(env,chat,'Sorry, that paper was not found.');
  if(!isOpen(env,db,s,p,uid)) return send(env,chat,'This paper is not open yet. It appears on the day of its exam.');
  if(db.paid?.[pid]?.some(x=>String(x.uid)===String(uid))) return deliverPaper(env,chat,uid,sid,pid,'resend');
  return createInvoice(env,chat,uid,s,p);
}
async function createInvoice(env,chat,uid,s,p) {
  if (!env.PAYMENT_PROVIDER_TOKEN) return send(env,chat,'Payments are not configured yet. The administrator must add the PAYMENT_PROVIDER_TOKEN secret in Cloudflare and configure a payment provider in BotFather.');
  const label=`${s.name} ${p.name}`.slice(0,32);
  const orderId=id(), payload=`kcse:${orderId}`;
  const order={id:orderId,payload,userId:String(uid),chatId:String(chat),subjectId:s.id,paperId:p.id,amount:PRICE_KES*100,currency:CURRENCY,status:'pending',createdAt:Date.now()};
  await env.BOT_KV.put(ORDER+orderId,JSON.stringify(order),{expirationTtl:604800});
  try {
    await tg(env,'sendInvoice',{
      chat_id:chat,title:label,description:`${s.name} — ${p.name}: all resources uploaded for this paper`,payload,
      provider_token:env.PAYMENT_PROVIDER_TOKEN,currency:CURRENCY,
      prices:[{label,amount:PRICE_KES*100}],
      start_parameter:`kcse_${orderId}`,need_name:false,need_phone_number:false,need_email:false,
      is_flexible:false
    });
  } catch(e) {
    await env.BOT_KV.delete(ORDER+orderId);
    console.error('Invoice error:',e.message);
    await send(env,chat,'Telegram could not create the invoice. Check that your configured payment provider supports KES and that PAYMENT_PROVIDER_TOKEN is correct.');
  }
}
async function sendResource(env,chat,r) {
  if(r.files.length===1&&r.files[0].kind==='document') return tg(env,'sendDocument',{chat_id:chat,document:r.files[0].fileId});
  if(r.files.every(f=>f.kind==='photo')) {
    for(let i=0;i<r.files.length;i+=10){const batch=r.files.slice(i,i+10);if(batch.length===1) await tg(env,'sendPhoto',{chat_id:chat,photo:batch[0].fileId});else await tg(env,'sendMediaGroup',{chat_id:chat,media:batch.map(f=>({type:'photo',media:f.fileId}))});}
  } else {
    for(const f of r.files){if(f.kind==='document') await tg(env,'sendDocument',{chat_id:chat,document:f.fileId});else await tg(env,'sendPhoto',{chat_id:chat,photo:f.fileId});}
  }
}
// Records the buyer's entitlement for the paper, then sends whatever is uploaded right now.
async function deliverPaper(env,chat,uid,sid,pid,mode) {
  const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid);
  if(!s||!p) return send(env,chat,'Payment was received, but the paper could not be found. Please contact the administrator.');
  db.paid=db.paid||{}; const list=(db.paid[pid]=db.paid[pid]||[]);
  let rec=list.find(x=>String(x.uid)===String(uid));
  if(!rec){rec={uid:String(uid),chat:String(chat),sent:[]};list.push(rec);}
  await dbPut(env,db);
  const name=`${esc(s.name)} — ${esc(p.name)}`;
  const rs=resources(db,sid,pid);
  const todo=mode==='resend'?rs:rs.filter(r=>!rec.sent.includes(r.id));
  if(!rs.length) return send(env,chat,mode==='resend'?`You have already paid for <b>${name}</b>. Nothing has been uploaded yet. It will be sent to you automatically as soon as it is available.`:`<b>Payment confirmed</b> for ${name}.\nNothing has been uploaded for this paper yet. It will be sent to you automatically as soon as it is available.`);
  await send(env,chat,mode==='resend'?`You have already paid for <b>${name}</b>. Sending it again:`:`<b>Payment confirmed</b> for ${name}.\nSending ${rs.length} resource${rs.length>1?'s':''}:`);
  for(const r of todo){
    try{await sendResource(env,chat,r);if(!rec.sent.includes(r.id))rec.sent.push(r.id);}
    catch(e){console.error('Delivery error:',e.message);await send(env,chat,`Delivery of "${esc(r.title)}" failed. Contact the administrator with your payment receipt.`);}
  }
  const fresh=await dbGet(env); const fr=(fresh.paid?.[pid]||[]).find(x=>String(x.uid)===String(uid));
  if(fr) fr.sent=[...new Set([...(fr.sent||[]),...rec.sent])];
  await dbPut(env,fresh);
}
// After an admin publishes a resource, send it to everyone who already paid for that paper.
async function notifyBuyers(env,sid,pid) {
  const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid); if(!s||!p) return 0;
  const rs=resources(db,sid,pid); let n=0;
  for(const rec of (db.paid?.[pid]||[])){
    const todo=rs.filter(r=>!(rec.sent||[]).includes(r.id)); if(!todo.length) continue;
    try{
      await send(env,rec.chat,`<b>New upload</b> for ${esc(s.name)} — ${esc(p.name)}, which you already paid for:`);
      for(const r of todo){await sendResource(env,rec.chat,r);rec.sent=[...(rec.sent||[]),r.id];}
      n++;
    }catch(e){console.error('Notify error:',e.message);}
  }
  await dbPut(env,db); return n;
}

async function adminHome(env,chat,mid) {
  const text='<b>Admin Panel</b>\nTap <b>Upload Resource</b>, pick the subject, paper and type, then send the files. Everything is done with buttons.\n\nOther commands:\n<code>/setdate Subject | Paper | YYYY-MM-DD</code>\n<code>/addsubject Subject name</code>\n<code>/addpaper Subject name | Paper 1</code>';
  const menu=kb([[b('Upload Resource','adm:up')],[b('View Catalogue','adm:list')],[b('Main Menu','stu:home')]]);
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
  const rs=resources(db,sid,pid),buyers=(db.paid?.[pid]||[]).length;
  const rows=rs.map(r=>[b(`${TYPES[r.type]||r.type}: ${r.title}`,'adm:resource:'+r.id)]);
  rows.unshift([b('Upload here',`adm:upp:${sid}:${pid}`)]);
  rows.push([b('Back',`adm:subject:${sid}`),b('Admin Home','adm:home')]);
  return edit(env,chat,mid,`<b>${esc(s.name)} — ${esc(p.name)}</b>\nExam date: ${paperDate(db,s,p)||'not set (hidden from students)'}\nPublished resources: ${rs.length}\nBuyers: ${buyers}`,kb(rows));
}
async function adminResource(env,chat,mid,rid) {
  const db=await dbGet(env),r=db.resources.find(x=>x.id===rid);if(!r)return edit(env,chat,mid,'Resource not found.',kb([[b('Admin Home','adm:home')]]));
  return edit(env,chat,mid,`<b>${esc(r.title)}</b>\nType: ${esc(TYPES[r.type]||r.type)}\nFiles: ${r.files.length}`,kb([[b('Delete','adm:del:'+r.id)],[b('Back',`adm:paper:${r.subjectId}:${r.paperId}`)]]));
}
// ---- Button-driven upload flow ----
async function upSubjects(env,chat,mid) {
  const db=await dbGet(env);const rows=db.subjects.map(s=>[b(s.name,'adm:ups:'+s.id)]);rows.push([b('Admin Home','adm:home')]);
  return edit(env,chat,mid,'<b>Upload — step 1 of 3</b>\nChoose the subject.',kb(rows));
}
async function upPapers(env,chat,mid,sid) {
  const db=await dbGet(env),s=findSubject(db,sid);if(!s)return upSubjects(env,chat,mid);
  const rows=s.papers.map(p=>[b(p.name,`adm:upp:${s.id}:${p.id}`)]);rows.push([b('Back','adm:up'),b('Admin Home','adm:home')]);
  return edit(env,chat,mid,`<b>Upload — step 2 of 3</b>\n${esc(s.name)}: choose the paper.`,kb(rows));
}
async function upTypes(env,chat,mid,sid,pid) {
  const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid);if(!s||!p)return upSubjects(env,chat,mid);
  const rows=Object.entries(TYPES).map(([t,label])=>[b(label,`adm:upt:${sid}:${pid}:${t}`)]);rows.push([b('Back',`adm:ups:${sid}`),b('Admin Home','adm:home')]);
  return edit(env,chat,mid,`<b>Upload — step 3 of 3</b>\n${esc(s.name)} — ${esc(p.name)}: what are you uploading?`,kb(rows));
}
const upKb = n => kb([[b(n?`Publish (${n} file${n>1?'s':''})`:'Publish','adm:fin')],[b('Cancel','adm:cancel')]]);
const upText = sess => `<b>Uploading</b>\n${esc(sess.label)}\nType: ${esc(TYPES[sess.type])}\nTitle: ${esc(sess.title)}\nFiles received: <b>${sess.files.length}</b>\n\nSend PDFs or images now (up to ${MAX_FILES}). Add a caption to the first file, or send a text message, to change the title. Tap Publish when done.`;
async function refreshUpload(env,sess) { if(!sess.mid)return; try{await tg(env,'editMessageText',{chat_id:sess.chatId,message_id:sess.mid,text:upText(sess),parse_mode:'HTML',reply_markup:upKb(sess.files.length)});}catch(e){if(!String(e.message).includes('not modified'))console.error('Status refresh:',e.message);} }
async function startUpload(env,chat,uid,s,p,type,title) {
  const db=await dbGet(env);
  const t=title||`${s.name} — ${p.name} — ${TYPES[type]} ${resources(db,s.id,p.id,type).length+1}`;
  const sess={mode:'upload',subjectId:s.id,paperId:p.id,type,title:t,customTitle:!!title,label:`${s.name} — ${p.name}`,files:[],chatId:String(chat)};
  const m=await send(env,chat,upText(sess),upKb(0));sess.mid=m.message_id;
  await setSession(env,uid,sess);
}
async function beginUpload(env,chat,uid,args) {
  const parts=args.split('|').map(x=>x.trim());
  if(parts.length<3) return send(env,chat,'Tip: use the <b>Upload Resource</b> button in /admin. Or type:\n<code>/upload Subject | Paper 1 | exam_paper | Optional title</code>\nTypes: <code>exam_paper</code>, <code>marking_scheme</code>, <code>revision_notes</code>.');
  const [subjectName,paperName,type,...titleParts]=parts;
  if(!TYPES[type]) return send(env,chat,'Unknown resource type. Use exam_paper, marking_scheme or revision_notes.');
  const db=await dbGet(env),s=db.subjects.find(x=>x.name.toLowerCase()===subjectName.toLowerCase()),p=s?.papers.find(x=>x.name.toLowerCase()===paperName.toLowerCase());
  if(!s||!p) return send(env,chat,'Subject or paper not found. Add it first with /addsubject or /addpaper. Names must match the catalogue.');
  return startUpload(env,chat,uid,s,p,type,titleParts.join(' | '));
}
async function finishUpload(env,chat,uid) {
  const sess=await getSession(env,uid);if(sess.mode!=='upload')return send(env,chat,'There is no active upload.');
  if(!sess.files?.length)return send(env,chat,'No files received yet. Send a PDF or images first, then tap Publish.');
  const db=await dbGet(env);db.resources.push({id:id(),subjectId:sess.subjectId,paperId:sess.paperId,type:sess.type,title:sess.title,files:sess.files,createdAt:Date.now()});
  await dbPut(env,db);await clearSession(env,uid);
  if(sess.mid){try{await tg(env,'editMessageReplyMarkup',{chat_id:sess.chatId,message_id:sess.mid,reply_markup:{inline_keyboard:[]}});}catch{}}
  const n=await notifyBuyers(env,sess.subjectId,sess.paperId);
  return send(env,chat,`Published: <b>${esc(sess.title)}</b>\nFiles: ${sess.files.length}\nSent automatically to ${n} buyer${n===1?'':'s'} who had already paid for this paper.`,kb([[b('Upload another to this paper',`adm:upp:${sess.subjectId}:${sess.paperId}`)],[b('Admin Home','adm:home')]]));
}
async function handleAdminMessage(env,msg) {
  const chat=msg.chat.id,uid=msg.from.id,text=String(msg.text||'').trim();
  let sess=await getSession(env,uid);
  if(text==='/cancel'){await clearSession(env,uid);return send(env,chat,'Pending action cancelled.');}
  if(sess.mode==='upload'&&(msg.document||msg.photo)){
    if(sess.files.length>=MAX_FILES)return send(env,chat,`Limit reached: ${MAX_FILES} files per resource. Tap Publish.`);
    if(msg.document)sess.files.push({kind:'document',fileId:msg.document.file_id,name:msg.document.file_name||'document'});
    else sess.files.push({kind:'photo',fileId:msg.photo[msg.photo.length-1].file_id});
    if(msg.caption&&!sess.customTitle&&sess.files.length===1){sess.title=msg.caption.trim();sess.customTitle=true;}
    await setSession(env,uid,sess);await refreshUpload(env,sess);return;
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
  if(text.startsWith('/setdate ')){
    const [subjectName,paperName,date]=text.slice(9).split('|').map(x=>x.trim());
    if(!subjectName||!paperName||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||isNaN(new Date(date+'T00:00:00Z')))return send(env,chat,'Use: <code>/setdate Subject name | Paper 1 | 2026-11-17</code>');
    const db=await dbGet(env),s=db.subjects.find(x=>x.name.toLowerCase()===subjectName.toLowerCase()),p=s?.papers.find(x=>x.name.toLowerCase()===paperName.toLowerCase());
    if(!s||!p)return send(env,chat,'Subject or paper not found. Names must match the catalogue.');
    db.dates=db.dates||{};db.dates[p.id]=date;await dbPut(env,db);return send(env,chat,`Exam date for <b>${esc(s.name)} — ${esc(p.name)}</b> set to ${fmtDate(date)}. It opens to students at 00:00 EAT that day.`);
  }
  if(text.startsWith('/upload '))return beginUpload(env,chat,uid,text.slice(8));
  if(text==='/admin')return adminHome(env,chat);
  if(text==='/start')return home(env,chat);
  if(sess.mode==='upload'&&text&&!text.startsWith('/')){sess.title=text.slice(0,100);sess.customTitle=true;await setSession(env,uid,sess);await refreshUpload(env,sess);return;}
  if(sess.mode==='upload')return send(env,chat,'Send files, then tap Publish. Use /cancel to discard.');
  return send(env,chat,'Admin commands:\n<code>/addsubject Subject name</code>\n<code>/addpaper Subject name | Paper 1</code>\n<code>/upload Subject | Paper | exam_paper | Optional title</code>\n<code>/setdate Subject | Paper | YYYY-MM-DD</code>\n<code>/finish</code>\n<code>/cancel</code>');
}

async function handleCallback(env,q) {
  await ack(env,q.id);const msg=q.message,chat=msg.chat.id,mid=msg.message_id,uid=q.from.id,data=q.data||'';
  if(data.startsWith('adm:')&&!isAdmin(env,uid))return send(env,chat,'Access denied.');
  if(data==='stu:home')return home(env,chat,mid);
  if(data==='stu:subjects')return subjectMenu(env,chat,mid);
  if(data==='stu:help')return edit(env,chat,mid,'<b>How it works</b>\n1. Subjects appear on the day of their exam. Choose a subject and paper.\n2. Pay KSh 1,000 through the Telegram invoice.\n3. After payment the bot sends everything uploaded for that paper. If nothing is uploaded yet, it sends it to you automatically as soon as it is.\n\nIf payment fails, do not pay again until you check your payment status.',kb([[b('Browse Subjects','stu:subjects')],[b('Main Menu','stu:home')]]));
  if(data.startsWith('stu:sub:'))return paperMenu(env,chat,mid,data.split(':')[2]);
  if(data.startsWith('stu:paper:')){const [, ,sid,pid]=data.split(':');return selectPaper(env,chat,uid,sid,pid);}
  if(data==='adm:home')return adminHome(env,chat,mid);
  if(data==='adm:up')return upSubjects(env,chat,mid);
  if(data.startsWith('adm:ups:'))return upPapers(env,chat,mid,data.split(':')[2]);
  if(data.startsWith('adm:upp:')){const [, ,sid,pid]=data.split(':');return upTypes(env,chat,mid,sid,pid);}
  if(data.startsWith('adm:upt:')){const [, ,sid,pid,type]=data.split(':');const db=await dbGet(env),s=findSubject(db,sid),p=findPaper(s,pid);if(!s||!p||!TYPES[type])return upSubjects(env,chat,mid);return startUpload(env,chat,uid,s,p,type,'');}
  if(data==='adm:fin')return finishUpload(env,chat,uid);
  if(data==='adm:cancel'){await clearSession(env,uid);return edit(env,chat,mid,'Upload cancelled.',kb([[b('Admin Home','adm:home')]]));}
  if(data.startsWith('adm:del:'))return edit(env,chat,mid,'Delete this resource? Students who already received it keep their copy.',kb([[b('Yes, delete','adm:delok:'+data.split(':')[2])],[b('No',`adm:resource:${data.split(':')[2]}`)]]));
  if(data.startsWith('adm:delok:')){const rid=data.split(':')[2],db=await dbGet(env),r=db.resources.find(x=>x.id===rid);db.resources=db.resources.filter(x=>x.id!==rid);await dbPut(env,db);return edit(env,chat,mid,'Resource deleted.',kb([[b(r?'Back to paper':'Admin Home',r?`adm:paper:${r.subjectId}:${r.paperId}`:'adm:home')]]));}
  if(data==='adm:list')return listAdmin(env,chat,mid);
  if(data.startsWith('adm:subject:'))return adminSubject(env,chat,mid,data.split(':')[2]);
  if(data.startsWith('adm:paper:')){const [, ,sid,pid]=data.split(':');return adminPaper(env,chat,mid,sid,pid);}
  if(data.startsWith('adm:resource:'))return adminResource(env,chat,mid,data.split(':')[2]);
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
    if(!order.paperId)return send(env,msg.chat.id,'Payment received for an old-format order. Contact the administrator.');
    await deliverPaper(env,msg.chat.id,msg.from.id,order.subjectId,order.paperId,'paid');return;
  }
  if(update.callback_query)return handleCallback(env,update.callback_query);
  if(!msg)return;
  const uid=msg.from?.id,chat=msg.chat.id,text=String(msg.text||'').trim();
  if(isAdmin(env,uid))return handleAdminMessage(env,msg);
  if(text==='/start')return home(env,chat);
  const sess=await getSession(env,uid);
  if(sess.mode==='search'&&text){const db=await dbGet(env),term=text.toLowerCase();const found=db.resources.filter(r=>r.files?.length&&r.title.toLowerCase().includes(term)).slice(0,20);if(!found.length)return send(env,chat,'No matching resources found.');return send(env,chat,'Search results:\n'+found.map(r=>`• ${esc(r.title)} — KSh ${PRICE_KES}`).join('\n'));}
  if(text==='/help')return send(env,chat,'Use /start to browse KCSE papers. Each paper costs KSh 1,000.');
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
