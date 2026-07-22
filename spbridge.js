/**
 * spbridge.js — GitHub API Bridge (v3)
 * O token é lido do cookie 'gh_token' — nunca fica hardcoded no código.
 * O admin configura o token uma vez em admin.html → Configurações.
 */
(function () {
  'use strict';

  const GH_OWNER  = 'nip-globo';
  const GH_REPO   = 'orcamento';
  const GH_FILE   = 'orc_sync.json';
  const GH_BRANCH = 'main';
  const GH_API    = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;
  const GH_RAW    = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_FILE}`;

  let _cache = null, _cacheSha = null, _cacheTs = 0;
  const CACHE_TTL = 60000;

  // ── Cookie helper ──────────────────────────────────────────────
  const COOKIE = {
    set(key, value, days) {
      try {
        const exp = days ? '; expires=' + new Date(Date.now() + days * 864e5).toUTCString() : '';
        document.cookie = encodeURIComponent(key) + '=' +
          encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value)) +
          exp + '; path=/; SameSite=Lax';
      } catch (e) {}
    },
    get(key) {
      try {
        const name = encodeURIComponent(key) + '=';
        for (let c of document.cookie.split(';')) {
          c = c.trim();
          if (c.startsWith(name)) return decodeURIComponent(c.substring(name.length));
        }
      } catch (e) {}
      return null;
    },
    remove(key) {
      document.cookie = encodeURIComponent(key) +
        '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax';
    }
  };

  function getToken() { return COOKIE.get('gh_token') || ''; }

  // ── Lê orc_sync.json ──────────────────────────────────────────
  async function ghRead() {
    if (_cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;
    try {
      const tok = getToken();
      const r = await fetch(GH_API + '?ref=' + GH_BRANCH + '&t=' + Date.now(), {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          ...(tok ? { 'Authorization': 'Bearer ' + tok } : {})
        }
      });
      if (!r.ok) throw new Error('read ' + r.status);
      const meta = await r.json();
      _cacheSha  = meta.sha;
      const data = JSON.parse(atob(meta.content.replace(/\n/g, '')));
      _cache = data; _cacheTs = Date.now();
      return data;
    } catch (e) {
      try {
        const r2 = await fetch(GH_RAW + '?t=' + Date.now());
        if (!r2.ok) throw new Error('raw ' + r2.status);
        const data = await r2.json();
        _cache = data; _cacheTs = Date.now();
        return data;
      } catch (e2) {
        console.error('[GH Bridge] Leitura falhou:', e2.message);
        return null;
      }
    }
  }

  // ── Salva orc_sync.json ───────────────────────────────────────
  async function ghWrite(data) {
    const tok = getToken();
    if (!tok) {
      console.warn('[GH Bridge] Token não configurado — dados só em cache local');
      _cache = data; _cacheTs = Date.now();
      return false;
    }
    try {
      if (!_cacheSha) await ghRead();
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
      const r = await fetch(GH_API, {
        method: 'PUT',
        headers: {
          'Accept':        'application/vnd.github.v3+json',
          'Authorization': 'Bearer ' + tok,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          message: 'sync: ' + new Date().toISOString(),
          content, sha: _cacheSha, branch: GH_BRANCH
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (r.status === 409 || (err.message || '').includes('sha')) {
          _cacheSha = null; _cache = null;
          await ghRead();
          return ghWrite(data);
        }
        throw new Error(r.status + ': ' + (err.message || ''));
      }
      const res = await r.json();
      _cacheSha = res.content && res.content.sha;
      _cache = data; _cacheTs = Date.now();
      return true;
    } catch (e) {
      console.error('[GH Bridge] Escrita falhou:', e.message);
      return false;
    }
  }

  // ── API Pública ───────────────────────────────────────────────
  window.SP_BRIDGE = {
    ready: false,

    async init() {
      try {
        const data = await ghRead();
        this.ready = !!data;
        if (data) await this.syncAll();
        return this.ready;
      } catch (e) {
        this.ready = false;
        return false;
      }
    },

    async get(key) {
      const data = await ghRead();
      if (!data || !(key in data)) return COOKIE.get(key);
      const val = data[key];
      const str = typeof val === 'string' ? val : JSON.stringify(val);
      COOKIE.set(key, str, 0.02);
      return str;
    },

    async set(key, value) {
      COOKIE.set(key, value, 0.02);
      // Se não está pronto, tenta inicializar primeiro
      if (!this.ready) {
        const ok = await this.init();
        if (!ok) { console.warn('[GH Bridge] Sem token — dado salvo só localmente'); return false; }
      }
      let data = await ghRead() || {};
      try { data[key] = typeof value === 'string' ? JSON.parse(value) : value; }
      catch (e) { data[key] = value; }
      data._atualizadoEm  = new Date().toISOString();
      data._atualizadoPor = (() => {
        try { return JSON.parse(COOKIE.get('orc_user') || '{}').email || ''; } catch(e){ return ''; }
      })();
      return ghWrite(data);
    },

    async syncAll() {
      const data = await ghRead();
      if (!data) return;
      for (const k of ['orc_h2','orc_usuarios','orc_vinculos','orc_delegacoes','orc_reset_sol','orc_c2']) {
        if (data[k] !== undefined) COOKIE.set(k, JSON.stringify(data[k]), 0.02);
      }
    },

    // Token — salvo em cookie (365 dias), nunca no código
    setToken(tok) { COOKIE.set('gh_token', tok, 365); _cacheSha = null; _cache = null; },
    hasToken()    { return !!getToken(); },

    setSession(u) { u._ts = Date.now(); COOKIE.set('orc_user', JSON.stringify(u), 0.33); },
    getSession() {
      try {
        const s = JSON.parse(COOKIE.get('orc_user') || 'null');
        return (s && s.email && (Date.now() - (s._ts || 0)) < 8 * 3600 * 1000) ? s : null;
      } catch(e) { return null; }
    },
    clearSession() { COOKIE.remove('orc_user'); },
    cookie: COOKIE,
    info() {
      return { backend: 'GitHub', repo: GH_OWNER+'/'+GH_REPO, tokenOk: !!getToken(), ready: this.ready };
    }
  };
})();
