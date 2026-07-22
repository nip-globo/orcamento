/**
 * spbridge.js — GitHub API Bridge (v3)
 * Backend compartilhado via GitHub API + orc_sync.json
 *
 * Como funciona:
 *  - Todos os dados ficam em orc_sync.json no repositório GitHub
 *  - Leitura: GitHub API (com SHA para escrita posterior)
 *  - Escrita: GitHub API com Personal Access Token (PAT)
 *  - Sessão do usuário: cookie (~8h)
 *  - Cache local: memória (60s) para evitar chamadas repetidas
 *
 * Configuração:
 *  1. Gere um PAT em https://github.com/settings/tokens
 *     → Fine-grained token → repo "orcamento" → Contents: Read & Write
 *  2. Cole o token em GH_TOKEN abaixo
 */

(function () {
  'use strict';

  const GH_OWNER  = 'nip-globo';
  const GH_REPO   = 'orcamento';
  const GH_FILE   = 'orc_sync.json';
  const GH_BRANCH = 'main';

  // ⚠️ COLE O TOKEN AQUI — mantenha entre as aspas
  const GH_TOKEN = 'github_pat_11ABCDE...';

  const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;
  const GH_RAW = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${GH_FILE}`;

  let _cache    = null;
  let _cacheSha = null;
  let _cacheTs  = 0;
  const CACHE_TTL = 60000;

  // ── Cookie (SP-safe) ──────────────────────────────────────────
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
        const name  = encodeURIComponent(key) + '=';
        const parts = document.cookie.split(';');
        for (let c of parts) {
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

  // ── Lê orc_sync.json ──────────────────────────────────────────
  async function ghRead() {
    if (_cache && (Date.now() - _cacheTs) < CACHE_TTL) return _cache;
    try {
      const r = await fetch(GH_API + '?ref=' + GH_BRANCH + '&t=' + Date.now(), {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          ...(GH_TOKEN ? { 'Authorization': 'Bearer ' + GH_TOKEN } : {})
        }
      });
      if (!r.ok) throw new Error('read ' + r.status);
      const meta    = await r.json();
      _cacheSha     = meta.sha;
      const content = JSON.parse(atob(meta.content.replace(/\n/g, '')));
      _cache        = content;
      _cacheTs      = Date.now();
      return content;
    } catch (e) {
      console.warn('[GH Bridge] Fallback raw:', e.message);
      try {
        const r2 = await fetch(GH_RAW + '?t=' + Date.now());
        if (!r2.ok) throw new Error('raw ' + r2.status);
        const content = await r2.json();
        _cache   = content;
        _cacheTs = Date.now();
        return content;
      } catch (e2) {
        console.error('[GH Bridge] Leitura falhou:', e2.message);
        return null;
      }
    }
  }

  // ── Salva orc_sync.json ───────────────────────────────────────
  async function ghWrite(data) {
    if (!GH_TOKEN) {
      console.warn('[GH Bridge] Token não configurado');
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
          'Authorization': 'Bearer ' + GH_TOKEN,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          message: 'sync: ' + new Date().toISOString(),
          content, sha: _cacheSha, branch: GH_BRANCH
        })
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        if (r.status === 409 || (err.message||'').includes('sha')) {
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
        if (data) {
          await this.syncAll();
          console.log('[GH Bridge] Pronto —', Object.keys(data).length, 'chaves');
        }
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
      for (const key of ['orc_h2','orc_usuarios','orc_vinculos','orc_delegacoes','orc_reset_sol','orc_c2']) {
        if (data[key] !== undefined) COOKIE.set(key, JSON.stringify(data[key]), 0.02);
      }
    },

    setSession(u) { u._ts = Date.now(); COOKIE.set('orc_user', JSON.stringify(u), 0.33); },
    getSession() {
      try {
        const s = JSON.parse(COOKIE.get('orc_user') || 'null');
        return (s && s.email && (Date.now() - (s._ts||0)) < 8*3600*1000) ? s : null;
      } catch(e){ return null; }
    },
    clearSession() { COOKIE.remove('orc_user'); },
    cookie: COOKIE,
    info() {
      return { backend:'GitHub', repo: GH_OWNER+'/'+GH_REPO, tokenOk:!!GH_TOKEN, ready:this.ready };
    }
  };

})();
