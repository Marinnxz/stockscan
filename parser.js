/* Shared QR-tag parser. Loaded by index.html (browser) and tools/test_parser.js (Node).
   Odoo tags look like:
     http://192.168.1.59:8069/web?#id=30047&view_type=form&model=product.template
   The id/model live in the URL FRAGMENT (after #), not the query string. */
(function (g) {
  function parseTag(text) {
    if (!text || typeof text !== "string") return null;
    var raw = text.trim();
    var url;
    try { url = new URL(raw); } catch (e) { return null; }

    // Params may sit in the fragment (Odoo web client) or, rarely, the query string.
    var params = null;
    var frag = url.hash || "";
    if (frag.charAt(0) === "#") frag = frag.slice(1);
    if (frag.charAt(0) === "?") frag = frag.slice(1);
    if (frag) params = new URLSearchParams(frag);
    if ((!params || !params.get("id")) && url.search) {
      var sp = new URLSearchParams(url.search);
      if (sp.get("id")) params = sp;
    }
    if (!params) return null;

    var id = params.get("id");
    var model = params.get("model") || "";
    if (!id || !/^\d+$/.test(id)) return null;

    var known = /^product\.(template|product)$/.test(model);
    return {
      productId: Number(id),
      model: model || "product.template",
      rawUrl: raw,
      host: url.host,
      unknownModel: model ? !known : false
    };
  }

  g.parseTag = parseTag;
  if (typeof module !== "undefined" && module.exports) module.exports = { parseTag: parseTag };
})(typeof window !== "undefined" ? window : globalThis);
