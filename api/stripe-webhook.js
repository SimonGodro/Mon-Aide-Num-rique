/*
 * Webhook Stripe : appelé automatiquement par Stripe après chaque paiement réussi
 * sur un des deux Payment Links (Essentiel / Premium).
 *
 * Ce qu'il fait, dans l'ordre :
 *   1. Vérifie que l'appel vient bien de Stripe (signature).
 *   2. Enregistre l'abonné dans Supabase (table "abonnes"), via la clé service_role
 *      (jamais exposée côté site : elle ne vit que dans les variables d'environnement
 *      Vercel, lues ici côté serveur).
 *   3. Envoie l'email de confirmation avec le numéro de Paul, via Resend.
 *
 * Variables d'environnement nécessaires (à définir dans Vercel > Project Settings >
 * Environment Variables — jamais dans ce fichier) :
 *   STRIPE_SECRET_KEY        clé secrète Stripe (Developers > API keys)
 *   STRIPE_WEBHOOK_SECRET    secret de signature du endpoint webhook (whsec_...)
 *   SUPABASE_URL             https://mjzjkszswgczcmwwncvy.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  clé "service_role" Supabase (Project Settings > API)
 *   RESEND_API_KEY           clé API Resend
 *   RESEND_FROM              adresse d'expédition vérifiée, ex : "Paul <bonjour@monaidenumerique.fr>"
 *   PAUL_PHONE_NUMBER        le numéro de Paul (facultatif : un texte de repli est utilisé tant
 *                            qu'elle n'est pas définie)
 */

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_missing');
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Nécessaire pour vérifier la signature Stripe : il faut le corps brut de la requête,
// pas du JSON déjà parsé.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature Stripe invalide :', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ received: true, ignored: event.type });
    return;
  }

  const session = event.data.object;
  const email = session.customer_details?.email || session.customer_email || '';
  const name = session.customer_details?.name || '';
  const phone = session.customer_details?.phone || '';
  const plan = session.client_reference_id === 'premium' ? 'Premium' : 'Essentiel';
  const amountTotal = session.amount_total ?? null;
  const currency = session.currency || 'eur';

  // 1. Supabase (best-effort : une erreur ici ne doit pas empêcher l'envoi de l'email —
  // d'où le try/catch : sans lui, une table absente ou une clé invalide faisait planter
  // toute la fonction avant d'arriver à l'envoi de l'email, exactement comme pour le
  // formulaire "Contactez-nous" avant qu'on le corrige).
  if (supabase) {
    try {
      const { error } = await supabase.from('abonnes').insert({
        stripe_session_id: session.id,
        email,
        name,
        phone,
        plan,
        amount_total: amountTotal,
        currency,
      });
      // Code 23505 = doublon (Stripe peut rejouer le même webhook) : on l'ignore.
      if (error && error.code !== '23505') {
        console.error('Erreur insertion Supabase :', error);
      }
    } catch (err) {
      console.error('Exception Supabase (abonnes) :', err);
    }
  } else {
    console.warn('Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants) — abonné non enregistré.');
  }

  // 2. Email de confirmation avec le numéro de Paul
  if (resend && email) {
    const paulNumber = process.env.PAUL_PHONE_NUMBER || 'communiqué très prochainement par email';
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM || '"Mon Aide Numerique" <onboarding@resend.dev>',
        to: email,
        subject: 'Votre accès à Paul est prêt',
        html: `
          <p>Bonjour${name ? ' ' + name : ''},</p>
          <p>Merci pour votre abonnement <strong>${plan}</strong> à Mon Aide Numérique.</p>
          <p>Voici le numéro à appeler pour joindre Paul&nbsp;:</p>
          <p style="font-size:1.4em;font-weight:700">${paulNumber}</p>
          <p>Nous vous conseillons de l'enregistrer tout de suite dans vos contacts (par exemple sous le nom « Paul Assistant »), pour ne pas risquer de l'oublier ou de le perdre.</p>
          <p>Si vous avez souscrit à cet abonnement pour un autre, vous pouvez transmettre ce numéro à la personne qui doit appeler Paul (par exemple un de vos parents).</p>
          <p>À bientôt,<br>L'équipe Mon Aide Numérique</p>
        `,
      });
    } catch (err) {
      console.error('Erreur envoi email Resend :', err);
    }
  } else if (!resend) {
    console.warn('Resend non configuré (RESEND_API_KEY manquante) — email non envoyé.');
  }

  res.status(200).json({ received: true });
};
