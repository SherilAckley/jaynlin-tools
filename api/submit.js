// api/submit.js - the agent's private submission handler (runs on THEIR site, keeps their keys secret).
//
// The feedback page POSTs the visitor's answers here as JSON. This function then:
//   1) Always emails the agent the feedback (the core promise: feedback goes to the listing agent).
//   2) If it's a real LEAD and the agent connected GoHighLevel, creates a contact via the free GoHighLevel API
//      and tags it, so the agent's own (free) follow-up workflow fires.
//   3) A buyer who is here with their own agent is NEVER turned into a lead and NEVER sent to the CRM (compliance).
//
// Keys live in environment variables on the agent's host (Vercel), never in the browser:
//   WEB3FORMS_KEY     - for the feedback email (free)
//   GHL_TOKEN         - GoHighLevel Private Integration token (free API; only leads are sent)
//   GHL_LOCATION_ID   - the agent's GoHighLevel location id

// ---- pure, testable routing core (no globals) ----
export async function route(payload, env, fetchImpl) {
  const p = payload || {};

  // Client intake surveys (seller / buyer) route differently: the person IS a prospect,
  // so we always email the agent AND always create a contact + note with their answers.
  const formType = p.form_type || 'showing-feedback';
  if (formType === 'seller-survey' || formType === 'buyer-survey') {
    return routeSurvey(p, env, fetchImpl, formType);
  }

  const who = p.visitor_type || '';
  const repped = who === 'buyer-repped';

  // Re-derive lead status on the server so a tampered page cannot inject a lead.
  const email = repped ? '' : (p.contact_email || '');
  const nbAddr = who === 'neighbor' ? (p.neighbor_home_address || '') : '';
  const isNeighborLead = who === 'neighbor' && !!(email || nbAddr);
  const isBuyerLead = who === 'buyer' && !!email;
  const isLead = isNeighborLead || isBuyerLead;

  const clean = Object.assign({}, p, { is_lead: isLead, contact_email: isLead ? email : '' });
  const routed = {};

  // 1) Always email the agent (feedback + leads).
  if (env.WEB3FORMS_KEY) {
    const body = Object.assign({
      access_key: env.WEB3FORMS_KEY,
      subject: (isLead ? 'New LEAD' : 'Showing feedback') + ' - ' + (p.listing_address || 'your listing')
    }, clean);
    const r = await fetchImpl('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    routed.email = { attempted: true, ok: !!(r && r.ok), status: r && r.status };
  }

  // 2) Leads -> GoHighLevel contact via the free API (only if configured).
  if (isLead && env.GHL_TOKEN && env.GHL_LOCATION_ID) {
    const firstName = p.contact_name || (isNeighborLead ? 'Neighbor lead' : 'Buyer lead');
    const contactBody = {
      locationId: env.GHL_LOCATION_ID,
      email: email,
      firstName: firstName,
      tags: ['Showing Feedback Lead', p.submission_type || 'lead'],
      source: 'Showing Feedback: ' + (p.listing_address || '')
    };
    const r = await fetchImpl('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.GHL_TOKEN,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(contactBody)
    });
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    routed.ghl = { attempted: true, ok: !!(r && r.ok), status: r && r.status };

    // Best-effort: attach a note with the details. Never fails the request.
    const contactId = data && (data.contact ? data.contact.id : data.id);
    if (r && r.ok && contactId) {
      const note = [
        'Showing Feedback lead for ' + (p.listing_address || 'a listing'),
        p.neighbor_home_address ? 'Their home: ' + p.neighbor_home_address : '',
        'Overall: ' + (p.overall_rating || 'n/a') + '/10',
        p.liked_most ? 'Liked: ' + p.liked_most : '',
        p.would_change ? 'Would change: ' + p.would_change : '',
        p.anything_else ? 'Note: ' + p.anything_else : ''
      ].filter(Boolean).join('\n');
      try {
        await fetchImpl('https://services.leadconnectorhq.com/contacts/' + contactId + '/notes', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.GHL_TOKEN,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: note })
        });
        routed.ghlNote = { attempted: true };
      } catch (e) { routed.ghlNote = { attempted: true, ok: false }; }
    }
  }

  return { ok: true, is_lead: isLead, routed: routed };
}

// ---- client intake survey routing (seller / buyer) ----
export async function routeSurvey(p, env, fetchImpl, formType) {
  const routed = {};
  const label = formType === 'seller-survey' ? 'Seller' : 'Buyer';
  const answers = Array.isArray(p.answers) ? p.answers : [];
  const noteText = [
    label + ' survey from ' + (p.contact_name || 'a client'),
    p.listing_address ? 'Property: ' + p.listing_address : '',
    p.contact_phone ? 'Phone: ' + p.contact_phone : '',
    p.contact_email ? 'Email: ' + p.contact_email : ''
  ].filter(Boolean)
   .concat(answers.map(function (a) { return (a.label || '') + ': ' + (a.value || ''); }))
   .join('\n');

  // 1) Always email the agent the survey.
  if (env.WEB3FORMS_KEY) {
    const body = {
      access_key: env.WEB3FORMS_KEY,
      subject: 'New ' + label + ' survey - ' + (p.contact_name || 'client'),
      name: p.contact_name || '',
      email: p.contact_email || '',
      phone: p.contact_phone || '',
      property: p.listing_address || '',
      answers: noteText
    };
    const r = await fetchImpl('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    routed.email = { attempted: true, ok: !!(r && r.ok), status: r && r.status };
  }

  // 2) Always create a GoHighLevel contact (they are a prospect) + attach the answers as a note.
  if (env.GHL_TOKEN && env.GHL_LOCATION_ID && (p.contact_email || p.contact_phone)) {
    const contactBody = {
      locationId: env.GHL_LOCATION_ID,
      firstName: p.contact_name || (label + ' prospect'),
      tags: [label + ' Survey', 'Client Intake'],
      source: label + ' survey'
    };
    if (p.contact_email) contactBody.email = p.contact_email;
    if (p.contact_phone) contactBody.phone = p.contact_phone;
    const r = await fetchImpl('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.GHL_TOKEN,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(contactBody)
    });
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    routed.ghl = { attempted: true, ok: !!(r && r.ok), status: r && r.status };

    const contactId = data && (data.contact ? data.contact.id : data.id);
    if (r && r.ok && contactId) {
      try {
        await fetchImpl('https://services.leadconnectorhq.com/contacts/' + contactId + '/notes', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + env.GHL_TOKEN,
            'Version': '2021-07-28',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body: noteText })
        });
        routed.ghlNote = { attempted: true };
      } catch (e) { routed.ghlNote = { attempted: true, ok: false }; }
    }
  }

  return { ok: true, form_type: formType, routed: routed };
}

// ---- Vercel handler wrapper ----
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  let payload = req.body;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
  try {
    const result = await route(payload || {}, process.env, fetch);
    res.status(200).json(result);
  } catch (e) {
    // Never leak internals; the visitor always sees a thank-you regardless.
    res.status(200).json({ ok: true, error: 'partial' });
  }
}
