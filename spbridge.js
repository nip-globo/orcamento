/**
 * spbridge.js — SharePoint REST API Bridge
 * Carregado pelo index.html quando rodando dentro do SharePoint
 * Usa cookies de sessão do usuário logado (sem App Registration)
 */

(function() {
  const SP_SITE = 'https://tvglobocorp.sharepoint.com/sites/PlanejamentoeGestodeProdutos';
  const LISTAS  = {
    'orc_h2':         { lista: 'OrcDados',    titulo: 'orc_h2'         },
    'orc_usuarios':   { lista: 'OrcUsuarios', titulo: 'orc_usuarios'   },
    'orc_vinculos':   { lista: 'OrcConfig',   titulo: 'orc_vinculos'   },
    'orc_delegacoes': { lista: 'OrcConfig',   titulo: 'orc_delegacoes' },
    'orc_reset_sol':  { lista: 'OrcConfig',   titulo: 'orc_reset_sol'  },
    'orc_c2':         { lista: 'OrcConfig',   titulo: 'orc_c2'         }
  };

  let _token = null;
  let _ready = false;

  // ── Request Digest (token CSRF) ───────────────────────────────
  async function getDigest() {
    if (_token) return _token;
    const r = await fetch(SP_SITE + '/_api/contextinfo', {
      method: 'POST', credentials: 'include',
      headers: { 'Accept': 'application/json;odata=verbose' }
    });
    if (!r.ok) throw new Error('Não autenticado no SharePoint');
    const d = await r.json();
    _token = d.d.GetContextWebInformation.FormDigestValue;
    setTimeout(() => { _token = null; }, 1500000);
    return _token;
  }

  // ── Lê item da lista ──────────────────────────────────────────
  async function spGet(lista, titulo) {
    const url = `${SP_SITE}/_api/web/lists/getbytitle('${lista}')/items` +
                `?$filter=Title eq '${titulo}'&$select=ID,Title,Dados&$top=1`;
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'application/json;odata=verbose' }
    });
    if (!r.ok) return null;
    const d = await r.json();
    const items = d.d.results;
    return items && items.length ? { id: items[0].ID, valor: items[0].Dados } : null;
  }

  // ── Cria ou atualiza item ─────────────────────────────────────
  async function spSet(lista, titulo, valor) {
    const digest   = await getDigest();
    const existing = await spGet(lista, titulo);
    const body     = JSON.stringify({
      '__metadata': { 'type': `SP.Data.${lista}ListItem` },
      'Title': titulo, 'Dados': valor
    });
    const url = existing
      ? `${SP_SITE}/_api/web/lists/getbytitle('${lista}')/items(${existing.id})`
      : `${SP_SITE}/_api/web/lists/getbytitle('${lista}')/items`;
    const headers = {
      'Accept': 'application/json;odata=verbose',
      'Content-Type': 'application/json;odata=verbose',
      'X-RequestDigest': digest,
      ...(existing ? { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' } : {})
    };
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers, body });
    return r.ok || r.status === 204;
  }

  // ── API pública ───────────────────────────────────────────────
  window.SP_BRIDGE = {
    ready: false,

    // Testa conexão e carrega dados
    async init() {
      try {
        await getDigest();
        _ready = true;
        this.ready = true;
        console.log('[SP Bridge] Conectado ao SharePoint');
        await this.syncAll();
        return true;
      } catch(e) {
        console.warn('[SP Bridge] Offline:', e.message);
        _ready = false;
        this.ready = false;
        return false;
      }
    },

    // Salva uma chave no SharePoint E no localStorage
    async set(key, value) {
      try { localStorage.setItem(key, value); } catch(e) {}
      if (!_ready || !LISTAS[key]) return;
      const { lista, titulo } = LISTAS[key];
      try { await spSet(lista, titulo, value); } catch(e) {
        console.warn('[SP Bridge] Erro ao salvar ' + key, e);
      }
    },

    // Carrega uma chave do SharePoint (fallback: localStorage)
    async get(key) {
      if (_ready && LISTAS[key]) {
        try {
          const { lista, titulo } = LISTAS[key];
          const item = await spGet(lista, titulo);
          if (item && item.valor) {
            try { localStorage.setItem(key, item.valor); } catch(e) {}
            return item.valor;
          }
        } catch(e) {}
      }
      try { return localStorage.getItem(key); } catch(e) { return null; }
    },

    // Sincroniza todas as chaves do SP para localStorage
    async syncAll() {
      if (!_ready) return;
      for (const key of Object.keys(LISTAS)) {
        try {
          const { lista, titulo } = LISTAS[key];
          const item = await spGet(lista, titulo);
          if (item && item.valor) {
            try { localStorage.setItem(key, item.valor); } catch(e) {}
          }
        } catch(e) {}
      }
      console.log('[SP Bridge] Sincronização completa');
    }
  };

})();
