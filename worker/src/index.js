// Servidor do Competitivo do StepOn (Cloudflare Worker + KV).
// Cada app publica o resumo das próprias corridas; qualquer app lê o de todos.
// Amigos: pedido por ID do Intervals, que só vale depois que o outro aceita (guardado em 'f:<id>').
// A chave do Intervals só serve para provar que o atleta é quem diz ser: é conferida no Intervals e descartada, nunca é gravada.

const OAUTH_ID = '1688'; // ID público do app no Intervals (não é segredo)
const ORIGENS = ['https://igordejesusp.github.io', 'http://localhost:8768'];
const MAXPED = 100; // pedidos pendentes por pessoa
const LIMITE = 700_000; // tamanho máximo do resumo de um atleta (bytes)

const cors = (req) => {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENS.includes(o) ? o : ORIGENS[0],
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
};
const json = (req, obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors(req), ...extra } });

// confere no Intervals se a chave pertence ao atleta
// aceita os dois jeitos: chave de API (Basic) ou o token do login do Intervals (Bearer)
async function confere(athlete, key, token) {
  if (!/^i\d{1,12}$/.test(athlete || '') || !(key || token)) return null;
  const r = await fetch(`https://intervals.icu/api/v1/athlete/${athlete}`, {
    headers: { Authorization: token ? 'Bearer ' + token : 'Basic ' + btoa('API_KEY:' + key) },
  });
  if (!r.ok) return null;
  const a = await r.json();
  return a && a.id === athlete ? a : null;
}

async function todos(env) {
  const out = [];
  let cursor;
  do {
    const l = await env.BR.list({ prefix: 'a:', cursor });
    const vals = await Promise.all(l.keys.map((k) => env.BR.get(k.name, 'json')));
    vals.forEach((v) => v && out.push(v));
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return out;
}

// cópia pronta da lista de todos ('cache:all'): o GET /all lê só ela (1 leitura em vez de listar o banco a cada abertura do mapa).
// Cada publicação troca só o registro da pessoa na cópia; a cada 15 min a cópia é refeita do zero para corrigir qualquer corrida perdida.
const SNAP = 'cache:all', SNAPMAX = 15 * 60e3;
async function refazSnap(env) {
  const L = await todos(env), txt = JSON.stringify(L);
  await env.BR.put(SNAP, txt, { metadata: { at: Date.now() } });
  return txt;
}
async function trocaNoSnap(env, id, reg) {
  const { value, metadata } = await env.BR.getWithMetadata(SNAP);
  if (!value) return refazSnap(env);
  let L; try { L = JSON.parse(value); } catch (e) { return refazSnap(env); }
  L = L.filter((u) => u && u.id !== id); if (reg) L.push(reg);
  await env.BR.put(SNAP, JSON.stringify(L), { metadata: { at: (metadata && metadata.at) || Date.now() } });
}

// ---------- amigos ----------
const vazio = () => ({ friends: [], inc: [], out: [] });
const lerF = async (env, id) => ({ ...vazio(), ...((await env.BR.get('f:' + id, 'json')) || {}) });
const gravaF = (env, id, f) => env.BR.put('f:' + id, JSON.stringify(f));
const sem = (l, x) => l.filter((y) => y !== x);
const com = (l, x) => (l.includes(x) ? l : [...l, x]);

async function amigos(env, eu, acao, alvo) {
  const me = await lerF(env, eu);
  let aviso = '';
  if (acao !== 'lista') {
    if (!/^i\d{1,12}$/.test(alvo || '') || alvo === eu) return { erro: 'ID inválido' };
    const ou = await lerF(env, alvo);
    if (acao === 'pedir') {
      if (me.friends.includes(alvo)) aviso = 'ja';
      else if (me.inc.includes(alvo)) { // o outro já tinha pedido: vira amizade
        me.inc = sem(me.inc, alvo); ou.out = sem(ou.out, eu);
        me.friends = com(me.friends, alvo); ou.friends = com(ou.friends, eu); aviso = 'aceito';
      } else if (ou.inc.length >= MAXPED && !ou.inc.includes(eu)) aviso = 'cheio';
      else { me.out = com(me.out, alvo); ou.inc = com(ou.inc, eu); aviso = 'enviado'; }
    } else if (acao === 'aceitar') {
      if (me.inc.includes(alvo)) {
        me.inc = sem(me.inc, alvo); ou.out = sem(ou.out, eu);
        me.friends = com(me.friends, alvo); ou.friends = com(ou.friends, eu); aviso = 'aceito';
      }
    } else if (acao === 'recusar') {
      me.inc = sem(me.inc, alvo); ou.out = sem(ou.out, eu);
    } else if (acao === 'remover') { // também cancela pedido enviado
      me.friends = sem(me.friends, alvo); ou.friends = sem(ou.friends, eu);
      me.out = sem(me.out, alvo); ou.inc = sem(ou.inc, eu);
    } else return { erro: 'ação inválida' };
    await Promise.all([gravaF(env, eu, me), gravaF(env, alvo, ou)]);
  }
  // nome e foto de quem já publicou, para o app mostrar os pedidos
  const pessoas = {};
  for (const id of new Set([...me.friends, ...me.inc, ...me.out])) {
    const r = await env.BR.get('a:' + id, 'json');
    if (r) pessoas[id] = { name: r.name, pic: r.pic };
  }
  return { ...me, pessoas, aviso, conhecido: acao === 'pedir' ? !!(await env.BR.get('a:' + alvo)) : undefined };
}

// ---------- curtidas e comentários ----------
// cada atividade tem a chave 's:<dono>:<atividade>' com { l: [ids que curtiram], m: [comentários] }
const CHAVE = /^i\d{1,12}:[A-Za-z0-9_-]{1,40}$/;
const MAXCOM = 200, MAXTXT = 280;
async function social(env, a, b) {
  const k = String(b.dono || '') + ':' + String(b.act || '');
  if (!CHAVE.test(k)) return { erro: 'atividade inválida' };
  const s = (await env.BR.get('s:' + k, 'json')) || { l: [], m: [] };
  const eu = b.athlete;
  if (b.acao === 'curtir') s.l = com(s.l, eu);
  else if (b.acao === 'descurtir') s.l = sem(s.l, eu);
  else if (b.acao === 'comentar') {
    const txt = String(b.txt || '').replace(/\s+/g, ' ').trim().slice(0, MAXTXT);
    if (!txt) return { erro: 'comentário vazio' };
    if (s.m.length >= MAXCOM) return { erro: 'limite de comentários' };
    s.m.push({ i: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), id: eu, name: a.name || eu, t: Date.now(), txt });
  } else if (b.acao === 'apagar') { // quem escreveu ou o dono da atividade
    s.m = s.m.filter((c) => !(c.i === b.cid && (c.id === eu || b.dono === eu)));
  } else return { erro: 'ação inválida' };
  if (!s.l.length && !s.m.length) await env.BR.delete('s:' + k);
  else await env.BR.put('s:' + k, JSON.stringify(s));
  return { ok: true, k, s };
}

// ---------- fotos dos treinos ----------
// a foto fica em 'p:<dono>:<atividade>:<foto>' (JPEG) e a lista do atleta em 'g:<dono>'
const ACT = /^[A-Za-z0-9_-]{1,40}$/, PID = /^[a-z0-9]{4,16}$/, MAXFOTOS = 300, MAXIMG = 900_000;
async function fotos(env, eu, b) {
  const lista = (await env.BR.get('g:' + eu, 'json')) || [];
  if (b.acao === 'apagar') {
    const f = lista.find((x) => x.p === b.pid);
    if (!f) return { erro: 'foto não encontrada' };
    await env.BR.delete('p:' + eu + ':' + f.a + ':' + f.p);
    const nova = lista.filter((x) => x.p !== b.pid);
    await env.BR.put('g:' + eu, JSON.stringify(nova));
    return { ok: true, lista: nova };
  }
  if (!ACT.test(b.act || '')) return { erro: 'atividade inválida' };
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.img || ''));
  if (!m || m[1].length > MAXIMG) return { erro: 'imagem inválida ou grande demais' };
  if (lista.length >= MAXFOTOS) return { erro: 'limite de fotos' };
  const bin = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  const pid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await env.BR.put('p:' + eu + ':' + b.act + ':' + pid, bin);
  lista.push({ a: b.act, p: pid, t: Date.now() });
  await env.BR.put('g:' + eu, JSON.stringify(lista));
  return { ok: true, lista };
}

// ---------- corrida em grupo: o dono marca os amigos que correram junto ----------
// 'mo:<dono>:<atividade>' = { amigos: [...] } ; 'm:<amigo>' = lista das corridas em que ele foi marcado
const ATV = /^[A-Za-z0-9_-]{1,40}$/, MAXMARC = 100;
const resumoOk = (r) => {
  if (!r || typeof r !== 'object') return null;
  const num = (x, max) => (Number.isFinite(+x) && +x >= 0 && +x <= max ? Math.round(+x) : 0);
  const pts = (L, n) => (Array.isArray(L) ? L.slice(0, n).filter((q) => Array.isArray(q) && Math.abs(q[0]) <= 90 && Math.abs(q[1]) <= 180).map((q) => [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]) : []);
  return {
    date: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(r.date || '')) ? String(r.date).slice(0, 16) : '',
    name: String(r.name || 'Corrida').slice(0, 60), dev: String(r.dev || '').slice(0, 40),
    dist: num(r.dist, 300000), mov: num(r.mov, 86400), elev: num(r.elev, 9000),
    map: pts(r.map, 120), terr: (Array.isArray(r.terr) ? r.terr : []).slice(0, 8).map((p) => pts(p, 150)).filter((p) => p.length >= 3),
  };
};
async function marcar(env, a, b) {
  if (!ATV.test(String(b.act || ''))) return { erro: 'atividade inválida' };
  const dono = b.athlete, k = 'mo:' + dono + ':' + b.act, f = await lerF(env, dono);
  const novos = [...new Set((Array.isArray(b.amigos) ? b.amigos : []).filter((id) => f.friends.includes(id)))].slice(0, 10);
  const res = resumoOk(b.resumo);
  if (novos.length && (!res || !res.date)) return { erro: 'resumo da corrida inválido' };
  const antes = ((await env.BR.get(k, 'json')) || {}).amigos || [];
  for (const id of new Set([...antes, ...novos])) {
    const L = ((await env.BR.get('m:' + id, 'json')) || []).filter((e) => !(e.de === dono && e.act === b.act));
    if (novos.includes(id)) L.unshift({ de: dono, nome: a.name || dono, act: b.act, ...res, em: Date.now() });
    await env.BR.put('m:' + id, JSON.stringify(L.slice(0, MAXMARC)));
  }
  if (novos.length) await env.BR.put(k, JSON.stringify({ amigos: novos })); else await env.BR.delete(k);
  return { ok: true, amigos: novos };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });

    if (req.method === 'GET' && url.pathname === '/all') {
      const { value, metadata } = await env.BR.getWithMetadata(SNAP);
      const velho = !value || !metadata || !metadata.at || Date.now() - metadata.at > SNAPMAX;
      const txt = velho ? await refazSnap(env) : value;
      return new Response(txt, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', ...cors(req) } });
    }

    if ((req.method === 'POST' && url.pathname === '/publish') || (req.method === 'DELETE' && url.pathname === '/me')) {
      const txt = await req.text();
      if (txt.length > LIMITE) return json(req, { erro: 'resumo grande demais' }, 413);
      let b;
      try { b = JSON.parse(txt); } catch (e) { return json(req, { erro: 'json inválido' }, 400); }
      const a = await confere(b.athlete, b.key, b.token);
      if (!a) return json(req, { erro: 'chave não confere com o atleta' }, 403);

      if (req.method === 'DELETE') {
        await env.BR.delete('a:' + b.athlete);
        await trocaNoSnap(env, b.athlete, null);
        return json(req, { ok: true });
      }
      const runs = Array.isArray(b.runs) ? b.runs.slice(0, 200) : [];
      // foto: a escolhida no app (JPEG pequeno) ou a do Intervals; "/no-profile-pic.png" (sem foto) vira vazio
      const foto = typeof b.foto === 'string' && b.foto.length < 40000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.foto) ? b.foto : '';
      const doIcu = /^https:\/\//.test(a.profile_medium || '') ? a.profile_medium : '';
      // cor escolhida no mapa e áreas dominadas (polígonos fechados pelas corridas): validados e limitados
      const cor = /^#[0-9a-fA-F]{6}$/.test(String(b.cor || '')) ? String(b.cor).toLowerCase() : '';
      const terr = (Array.isArray(b.terr) ? b.terr : []).slice(0, 160).map((z) => {
        if (!z || !/^\d{4}-\d{2}-\d{2}$/.test(String(z.d || '')) || !Array.isArray(z.p)) return null;
        const p = z.p.slice(0, 150).filter((q) => Array.isArray(q) && Math.abs(q[0]) <= 90 && Math.abs(q[1]) <= 180).map((q) => [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5]);
        const h = /^\d{2}:\d{2}$/.test(String(z.h || '')) ? z.h : undefined;
        return p.length >= 3 ? { d: z.d, h, p } : null;
      }).filter(Boolean);
      const reg = { id: b.athlete, name: a.name || b.athlete, pic: foto || doIcu, sex: a.sex || '', cor, terr, runs, xp: Math.max(0, Math.min(1e6, Math.round(Number(b.xp) || 0))), at: Date.now() };
      await env.BR.put('a:' + b.athlete, JSON.stringify(reg));
      await trocaNoSnap(env, b.athlete, reg);
      return json(req, { ok: true, runs: runs.length });
    }

    // reserva do login: só repassa a troca do código ao Intervals (cliente público, sem senha do app)
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let b;
      try { b = JSON.parse(await req.text()); } catch (e) { return json(req, { erro: 'json inválido' }, 400); }
      if (String(b.client_id) !== OAUTH_ID || !b.code || !b.code_verifier) return json(req, { erro: 'pedido inválido' }, 400);
      const f = new URLSearchParams({ client_id: OAUTH_ID, code: b.code, code_verifier: b.code_verifier, redirect_uri: b.redirect_uri || '', grant_type: 'authorization_code' });
      const r = await fetch('https://intervals.icu/api/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: f });
      return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
    }

    if (req.method === 'GET' && url.pathname === '/social') {
      const ks = [...new Set(String(url.searchParams.get('k') || '').split(',').filter((k) => CHAVE.test(k)))].slice(0, 60);
      const out = {};
      await Promise.all(ks.map(async (k) => { const v = await env.BR.get('s:' + k, 'json'); if (v) out[k] = v; }));
      return json(req, out, 200, { 'Cache-Control': 'no-store' });
    }

    if (req.method === 'POST' && url.pathname === '/social') {
      const txt = await req.text();
      if (txt.length > 4000) return json(req, { erro: 'pedido grande demais' }, 413);
      let b;
      try { b = JSON.parse(txt); } catch (e) { return json(req, { erro: 'json inválido' }, 400); }
      const a = await confere(b.athlete, b.key, b.token);
      if (!a) return json(req, { erro: 'chave não confere com o atleta' }, 403);
      const r = await social(env, a, b);
      return json(req, r, r.erro ? 400 : 200);
    }

    if (req.method === 'GET' && url.pathname === '/fotos') {
      const dono = url.searchParams.get('dono') || '';
      if (!/^i\d{1,12}$/.test(dono)) return json(req, { erro: 'atleta inválido' }, 400);
      return json(req, (await env.BR.get('g:' + dono, 'json')) || [], 200, { 'Cache-Control': 'no-store' });
    }

    if (req.method === 'GET' && url.pathname === '/foto') {
      const [dono, act, pid] = String(url.searchParams.get('k') || '').split(':');
      if (!/^i\d{1,12}$/.test(dono || '') || !ACT.test(act || '') || !PID.test(pid || '')) return json(req, { erro: 'foto inválida' }, 400);
      const v = await env.BR.get('p:' + dono + ':' + act + ':' + pid, 'arrayBuffer');
      if (!v) return json(req, { erro: 'foto não encontrada' }, 404);
      return new Response(v, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ...cors(req) } });
    }

    if (req.method === 'POST' && url.pathname === '/foto') {
      const txt = await req.text();
      if (txt.length > MAXIMG + 2000) return json(req, { erro: 'foto grande demais' }, 413);
      let b;
      try { b = JSON.parse(txt); } catch (e) { return json(req, { erro: 'json inválido' }, 400); }
      const a = await confere(b.athlete, b.key, b.token);
      if (!a) return json(req, { erro: 'chave não confere com o atleta' }, 403);
      const r = await fotos(env, b.athlete, b);
      return json(req, r, r.erro ? 400 : 200);
    }

    if (req.method === 'POST' && (url.pathname === '/marcar' || url.pathname === '/marcados')) {
      const txt = await req.text();
      if (txt.length > 120000) return json(req, { erro: 'pedido grande demais' }, 413);
      let b;
      try { b = JSON.parse(txt); } catch (e) { return json(req, { erro: 'json inválido' }, 400); }
      const a = await confere(b.athlete, b.key, b.token);
      if (!a) return json(req, { erro: 'chave não confere com o atleta' }, 403);
      if (url.pathname === '/marcar') { const r = await marcar(env, a, b); return json(req, r, r.erro ? 400 : 200); }
      // marcados: a lista de corridas em que a pessoa foi marcada; acao 'remover' tira uma delas
      let L = (await env.BR.get('m:' + b.athlete, 'json')) || [];
      if (b.acao === 'remover' && ATV.test(String(b.act || ''))) {
        L = L.filter((e) => !(e.de === b.de && e.act === b.act)); await env.BR.put('m:' + b.athlete, JSON.stringify(L));
        const k = 'mo:' + b.de + ':' + b.act, o = await env.BR.get(k, 'json');
        if (o) { o.amigos = (o.amigos || []).filter((x) => x !== b.athlete); if (o.amigos.length) await env.BR.put(k, JSON.stringify(o)); else await env.BR.delete(k); }
      }
      return json(req, { ok: true, lista: L });
    }

    if (req.method === 'GET' && url.pathname === '/juntos') {
      const ks = [...new Set(String(url.searchParams.get('k') || '').split(',').filter((k) => /^i\d{1,12}:[A-Za-z0-9_-]{1,40}$/.test(k)))].slice(0, 60);
      const out = {};
      await Promise.all(ks.map(async (k) => { const v = await env.BR.get('mo:' + k, 'json'); if (v && v.amigos && v.amigos.length) out[k] = v.amigos; }));
      return json(req, out, 200, { 'Cache-Control': 'no-store' });
    }

    if (req.method === 'POST' && url.pathname === '/amigos') {
      let b;
      try { b = JSON.parse(await req.text()); } catch (e) { return json(req, { erro: 'json inválido' }, 400); }
      const a = await confere(b.athlete, b.key, b.token);
      if (!a) return json(req, { erro: 'chave não confere com o atleta' }, 403);
      const r = await amigos(env, b.athlete, b.acao || 'lista', b.alvo);
      return json(req, r, r.erro ? 400 : 200);
    }

    return json(req, { app: 'StepOn', rotas: ['GET /all', 'POST /publish', 'DELETE /me', 'POST /amigos', 'GET /social', 'POST /social', 'GET /fotos', 'GET /foto', 'POST /foto', 'POST /marcar', 'POST /marcados', 'GET /juntos', 'POST /oauth/token'] });
  },
};
