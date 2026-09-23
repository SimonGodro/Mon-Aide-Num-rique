/*
 * Formulaire "Contactez-nous" (être rappelé) : reçoit les demandes envoyées depuis
 * le site, les enregistre dans Supabase (table "demandes_rappel"), puis VOUS envoie
 * un email pour que vous sachiez qu'il faut rappeler la personne. Avant ce fichier,
 * le formulaire écrivait directement dans Supabase depuis le navigateur et personne
 * n'était prévenu : c'est ce qui manquait pour que "Contactez-nous" serve à quelque
 * chose côté équipe.
 *
 * Variables d'environnement nécessaires (à définir dans Vercel > Project Settings >
 * Environment Variables — jamais dans ce fichier) :
 *   SUPABASE_URL               https://mjzjkszswgczcmwwncvy.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  clé "service_role" Supabase (Project Settings > API)
 *   RESEND_API_KEY             clé API Resend
 *   RESEND_FROM                adresse d'expédition vérifiée, ex : "Paul <bonjour@monaidenumerique.fr>"
 *   CONTACT_NOTIFY_EMAIL       votre adresse email : celle qui doit recevoir les
 *                              demandes de rappel (probablement la vôtre, Simon)
 */

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.status(400).json({ error: 'JSON invalide' });
    return;
  }

  // anti-spam : champ caché rempli par un robot -> on répond "ok" sans rien faire
  if (body.website) {
    res.status(200).json({ ok: true });
    return;
  }

  const name = (body.name || '').toString().trim().slice(0, 200);
  const phone = (body.phone || '').toString().trim().slice(0, 50);
  const consent = !!body.consent;

  if (!name || !phone || !consent) {
    res.status(400).json({ error: 'Champs manquants' });
    return;
  }

  // 1. Supabase (best-effort : une erreur ici ne doit pas empêcher l'email de vous prévenir)
  if (supabase) {
    const { error } = await supabase.from('demandes_rappel').insert({ name, phone, consent });
    if (error) console.error('Erreur insertion Supabase (demandes_rappel) :', error);
  } else {
    console.warn('Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants) — demande non enregistrée.');
  }

  // 2. Email pour vous prévenir qu'il faut rappeler la personne
  if (resend && process.env.CONTACT_NOTIFY_EMAIL) {
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || 'Mon Aide Numérique <onboarding@resend.dev>',
        to: process.env.CONTACT_NOTIFY_EMAIL,
        subject: `Nouvelle demande de rappel — ${name}`,
        html: `
          <p>Nouvelle demande de rappel reçue sur le site "Contactez-nous".</p>
          <p><strong>Prénom&nbsp;:</strong> ${name}<br>
          <strong>Téléphone&nbsp;:</strong> ${phone}</p>
          <p>Merci de la rappeler dès que possible.</p>
        `,
      });
    } catch (err) {
      console.error('Erreur envoi email Resend (demande de rappel) :', err);
    }
  } else {
    console.warn('Resend ou CONTACT_NOTIFY_EMAIL non configuré — email de notification non envoyé.');
  }

  res.status(200).json({ ok: true });
};
