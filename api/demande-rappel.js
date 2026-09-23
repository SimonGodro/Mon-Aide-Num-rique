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

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    // Les clients Supabase/Resend sont construits ICI, dans le try, plutôt qu'en haut
    // du fichier au chargement du module : si un module est introuvable ou une clé mal
    // formée fait planter sa construction, avant on ne le voyait jamais (Vercel renvoyait
    // un 500 générique avant même d'exécuter une ligne à nous) — maintenant c'est capturé
    // et le détail est renvoyé ci-dessous, dans la réponse, pour diagnostiquer facilement.
    let supabase = null;
    let resend = null;
    try {
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const { createClient } = require('@supabase/supabase-js');
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      }
    } catch (err) {
      console.error('Erreur initialisation Supabase :', err);
    }
    try {
      if (process.env.RESEND_API_KEY) {
        const { Resend } = require('resend');
        resend = new Resend(process.env.RESEND_API_KEY);
      }
    } catch (err) {
      console.error('Erreur initialisation Resend :', err);
    }

    // Vercel lit et parse déjà le corps JSON de la requête automatiquement (req.body) :
    // il ne faut pas essayer de relire le flux brut soi-même (c'est ce qui causait
    // l'erreur "Un problème est survenu" — req.body était ignoré et donc vide).
    const body = req.body && typeof req.body === 'object' ? req.body : {};

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

    // Diagnostic temporaire (visible dans l'onglet Réseau du navigateur, réponse de la
    // requête) : à retirer une fois le problème identifié. N'affecte pas le formulaire,
    // le site ne regarde que le statut 200, jamais ce contenu.
    const debug = {
      supabaseConfigured: !!supabase,
      supabaseError: null,
      resendConfigured: !!resend,
      notifyEmailSet: !!process.env.CONTACT_NOTIFY_EMAIL,
      resendError: null,
    };

    // 1. Supabase (best-effort : une erreur ici ne doit pas empêcher l'email de vous prévenir,
    // ni faire planter la fonction — d'où le try/catch : sans lui, une clé invalide ou une
    // table absente faisait remonter une erreur non gérée et renvoyait "Un problème est survenu").
    if (supabase) {
      try {
        const { error } = await supabase.from('demandes_rappel').insert({ name, phone, consent });
        if (error) { console.error('Erreur insertion Supabase (demandes_rappel) :', error); debug.supabaseError = error.message || String(error); }
      } catch (err) {
        console.error('Exception Supabase (demandes_rappel) :', err);
        debug.supabaseError = (err && err.message) || String(err);
      }
    } else {
      console.warn('Supabase non configuré (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants) — demande non enregistrée.');
    }

    // 2. Email pour vous prévenir qu'il faut rappeler la personne
    if (resend && process.env.CONTACT_NOTIFY_EMAIL) {
      try {
        const sendResult = await resend.emails.send({
          from: process.env.RESEND_FROM || '"Mon Aide Numerique" <onboarding@resend.dev>',
          to: process.env.CONTACT_NOTIFY_EMAIL,
          subject: `Nouvelle demande de rappel — ${name}`,
          html: `
            <p>Nouvelle demande de rappel reçue sur le site "Contactez-nous".</p>
            <p><strong>Prénom&nbsp;:</strong> ${name}<br>
            <strong>Téléphone&nbsp;:</strong> ${phone}</p>
            <p>Merci de la rappeler dès que possible.</p>
          `,
        });
        if (sendResult && sendResult.error) { console.error('Erreur envoi email Resend (demande de rappel) :', sendResult.error); debug.resendError = sendResult.error.message || String(sendResult.error); }
      } catch (err) {
        console.error('Erreur envoi email Resend (demande de rappel) :', err);
        debug.resendError = (err && err.message) || String(err);
      }
    } else {
      console.warn('Resend ou CONTACT_NOTIFY_EMAIL non configuré — email de notification non envoyé.');
    }

    res.status(200).json({ ok: true, debug });
  } catch (err) {
    // Filet de sécurité : si quelque chose d'imprévu plante, on le journalise clairement
    // (visible dans Vercel > Deployments > ce déploiement > Functions > demande-rappel,
    // onglet "Logs") au lieu de laisser Vercel renvoyer une erreur 500 muette.
    // "detail" est temporaire, pour diagnostiquer facilement depuis l'onglet Réseau du
    // navigateur : à retirer une fois le problème identifié et corrigé (ne contient rien
    // de confidentiel — juste le message d'erreur technique Node/Supabase/Resend).
    console.error('Erreur inattendue /api/demande-rappel :', err);
    res.status(500).json({ error: 'Erreur serveur', detail: String((err && err.message) || err) });
  }
};
