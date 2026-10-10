// Modèles d’e-mails (français + anglais pour les courtiers hors francophonie) et texte du mandat.
// Typographie française : espace insécable (U+00A0) avant : ; ? ! et à l’intérieur des « », apostrophe ’.
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const COMPANY = process.env.COMPANY_NAME || 'Oubli SAS';
const COMPANY_ADDR = process.env.COMPANY_ADDRESS || '12 rue des Capucins, 69001 Lyon, France';
export const MANDATE_VERSION = '2026-10';

const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtDateEn = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const list = (arr) => (arr && arr.length ? arr.join(', ') : '—');
const j = (s) => { if (Array.isArray(s)) return s; try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

// Autorité de contrôle compétente : celle du lieu de résidence de la personne concernée (article 77 du RGPD).
const authorityFr = (profile) => ((profile?.country || 'FR').toUpperCase() === 'FR' ? 'la CNIL' : 'l’autorité de contrôle de son État de résidence');

const LABELS = {
  fr: { last: 'Nom', first: 'Prénom', birth: 'Date de naissance', country: 'Pays de résidence', emails: 'Adresses e-mail', phones: 'Téléphones', addresses: 'Adresses postales', aliases: 'Autres noms utilisés', sep: ' : ', date: fmtDate },
  en: { last: 'Last name', first: 'First name', birth: 'Date of birth', country: 'Country of residence', emails: 'E-mail addresses', phones: 'Phone numbers', addresses: 'Postal addresses', aliases: 'Other names used', sep: ': ', date: fmtDateEn },
};
export function identityBlock(profile, lang = 'fr') {
  const L = LABELS[lang] || LABELS.fr;
  const row = (label, value) => `${label}${L.sep}${value}`;
  return [
    row(L.last, String(profile.last_name || '').toUpperCase()),
    row(L.first, profile.first_name || ''),
    profile.birth_date ? row(L.birth, L.date(profile.birth_date)) : null,
    row(L.country, profile.country || 'FR'),
    row(L.emails, list(j(profile.emails))),
    row(L.phones, list(j(profile.phones))),
    row(L.addresses, list(j(profile.addresses))),
    j(profile.aliases).length ? row(L.aliases, list(j(profile.aliases))) : null,
  ].filter(Boolean).join('\n');
}

export function removalRequest({ profile, broker, user, ref, mandateDate, url = null }) {
  const rgpd = broker.legal_basis !== 'ccpa';
  const ccpa = broker.legal_basis !== 'rgpd';
  const uk = broker.jurisdiction === 'UK';
  const gdpr = uk ? 'UK GDPR' : 'GDPR';
  const basisFr = rgpd ? (uk ? 'art. 17 UK GDPR' : 'art. 17 RGPD') : 'CCPA';
  const subject = `Demande d’effacement de données personnelles — ${basisFr} [${ref}]`;

  const fr = `Madame, Monsieur,

Au nom et pour le compte de la personne identifiée ci-dessous, en vertu du mandat écrit qui nous a été confié le ${fmtDate(mandateDate)} (copie disponible sur demande), nous vous demandons :

1. de confirmer si vous détenez des données personnelles la concernant${rgpd ? ' (article 15 du RGPD)' : ' (Cal. Civ. Code § 1798.110)'} ;
2. de supprimer l’ensemble de ces données, y compris les profils, agrégats, identifiants et copies de sauvegarde${rgpd ? ' (article 17 du RGPD, « droit à l’effacement »)' : ''}${ccpa ? ' (California Consumer Privacy Act, Cal. Civ. Code § 1798.105, « right to delete »)' : ''} ;
3. de cesser tout traitement à des fins de prospection ou de profilage${rgpd ? ' (article 21, paragraphe 2, du RGPD : opposition sans motif à exprimer)' : ''}${ccpa ? ' et de ne pas vendre ni partager ces informations (Cal. Civ. Code § 1798.120)' : ''} ;
4. de ne pas réintégrer ces données ultérieurement et de nous indiquer les destinataires auxquels elles ont été communiquées${rgpd ? ' (article 19 du RGPD)' : ''}.

Identité de la personne concernée :
${identityBlock(profile, 'fr')}
${url ? `\nLa fiche concernée est consultable à l’adresse suivante :\n${url}\n` : ''}
${rgpd ? 'Conformément à l’article 12, paragraphe 3, du RGPD, nous attendons votre réponse dans un délai d’un mois à compter de la réception de ce message.' : 'Conformément au CCPA (Cal. Civ. Code § 1798.130), nous attendons votre réponse dans un délai de 45 jours à compter de la réception de ce message.'} À défaut, une réclamation pourra être déposée auprès de ${authorityFr(profile)}.

Merci de répondre à ce message en conservant la référence [${ref}] dans l’objet.

Cordialement,
${COMPANY}, mandataire de la personne concernée
${COMPANY_ADDR}
Référence : ${ref}`;

  const deadlineEn = rgpd && ccpa
    ? `Under Article 12(3) ${gdpr} you must respond within one month of receipt; under the CCPA (Cal. Civ. Code § 1798.130) within 45 days.`
    : rgpd ? `Under Article 12(3) ${gdpr} you must respond within one month of receipt${uk ? '; otherwise a complaint may be lodged with the ICO' : ''}.`
      : 'Under the CCPA (Cal. Civ. Code § 1798.130) you must respond within 45 days of receipt.';
  const en = `Dear Sir or Madam,

On behalf of the data subject identified below, under a written authorisation granted to us on ${fmtDateEn(mandateDate)} (copy available on request), we request that you:

1. confirm whether you hold personal data relating to this person${rgpd ? ` (Article 15 ${gdpr})` : ' (Cal. Civ. Code § 1798.110)'};
2. delete all such data, including profiles, derived data, identifiers and backups${rgpd ? ` (Article 17 ${gdpr}, right to erasure)` : ''}${ccpa ? ' (California Consumer Privacy Act, Cal. Civ. Code § 1798.105, right to delete)' : ''};
3. stop any processing for direct marketing or profiling purposes${rgpd ? ` (Article 21(2) ${gdpr})` : ''}${ccpa ? ' and do not sell or share this personal information (Cal. Civ. Code § 1798.120)' : ''};
4. refrain from re-adding this data in the future and tell us which recipients received it${rgpd ? ` (Article 19 ${gdpr})` : ''}.

Data subject:
${identityBlock(profile, 'en')}
${url ? `\nThe listing concerned is available at:\n${url}\n` : ''}
${deadlineEn} Please keep the reference [${ref}] in the subject line of your reply.

Kind regards,
${COMPANY}, authorised agent of the data subject
${COMPANY_ADDR}
Reference: ${ref}`;

  const frFirst = broker.jurisdiction === 'FR' || broker.jurisdiction === 'EU';
  return { subject, text: frFirst ? `${fr}\n\n— English version below —\n\n${en}` : `${en}\n\n— Version française ci-dessous —\n\n${fr}` };
}

export function followUp({ broker, ref, sentAt, profile }) {
  const rgpd = broker.legal_basis !== 'ccpa';
  const ccpa = broker.legal_basis !== 'rgpd';
  return {
    subject: `Relance — demande d’effacement sans réponse [${ref}]`,
    text: `Madame, Monsieur,

Notre demande d’effacement référencée [${ref}], envoyée le ${fmtDate(sentAt)}, est restée sans réponse à l’expiration du délai légal ${rgpd ? 'd’un mois (article 12, paragraphe 3, du RGPD)' : 'de 45 jours (CCPA)'}.

Nous vous demandons de confirmer la suppression des données sous 8 jours. À défaut, nous saisirons ${authorityFr(profile)}${ccpa ? ' et la California Privacy Protection Agency' : ''}.

— Reminder: our erasure request [${ref}] sent on ${fmtDateEn(sentAt)} received no answer within the statutory period${rgpd ? ' (Article 12(3) GDPR)' : ' (CCPA, 45 days)'}. Please confirm deletion within 8 days; otherwise a complaint will be filed with the competent supervisory authority${ccpa ? ' and the California Privacy Protection Agency' : ''}.

${COMPANY}, mandataire — Référence : ${ref}`,
  };
}

// Rapport mensuel : un bloc par personne protégée, chiffres du cycle en cours et actions à faire.
export function monthlyReport({ month, blocks }) {
  const lines = blocks.map((b) => [
    b.name,
    `  • ${b.done} effacement${b.done > 1 ? 's' : ''} confirmé${b.done > 1 ? 's' : ''}${b.doneMonth ? ` (dont ${b.doneMonth} ce mois-ci)` : ''}`,
    `  • ${b.inProgress} demande${b.inProgress > 1 ? 's' : ''} en cours`,
    b.action ? `  • ${b.action} vérification${b.action > 1 ? 's' : ''} attend${b.action > 1 ? 'ent' : ''} votre action` : null,
    b.refused ? `  • ${b.refused} refus : réclamation en préparation` : null,
    `  • Exposition estimée : ${b.exposure} %`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return {
    subject: `Votre rapport mensuel Oubli — ${month}`,
    text: `Bonjour,

Voici où en est votre dossier.

${lines}

Le détail, demande par demande : ${APP_URL}/app/#dashboard
Rapport imprimable : ${APP_URL}/app/#report

Vous recevez ce rapport parce qu’il est activé dans vos paramètres (${APP_URL}/app/#settings).
— L’équipe Oubli`,
  };
}

export function welcomeMail({ email }) {
  return {
    subject: 'Bienvenue chez Oubli — votre dossier est ouvert',
    text: `Bonjour,

Votre compte Oubli est créé pour ${email}. Trois étapes restent à faire pour lancer la première vague de demandes :
1. renseigner les informations à faire effacer ;
2. signer le mandat électronique (révocable à tout moment) ;
3. choisir une offre.

Votre tableau de bord : ${APP_URL}/app/

À bientôt,
L’équipe Oubli`,
  };
}

export function actionRequiredMail({ broker, ref }) {
  return {
    subject: `Action requise — ${broker.name} demande une vérification [${ref}]`,
    text: `Bonjour,

${broker.name} demande une vérification avant de supprimer vos données (généralement un clic sur un lien de confirmation ou une pièce d’identité partielle). Rendez-vous sur votre tableau de bord pour voir la marche à suivre :
${APP_URL}/app/#dashboard

Référence : ${ref}
L’équipe Oubli`,
  };
}

export function mandateText({ user, profile, signedAt }) {
  return `MANDAT DE REPRÉSENTATION — version ${MANDATE_VERSION}

Mandant : ${profile.first_name} ${String(profile.last_name || '').toUpperCase()} (${user.email})
Mandataire : ${COMPANY}, ${COMPANY_ADDR}

Le mandant autorise le mandataire à exercer en son nom et pour son compte, auprès de tout courtier en données, site de recherche de personnes, annuaire ou responsable de traitement, les droits prévus par les articles 15, 17, 19 et 21 du Règlement (UE) 2016/679 (RGPD), par le UK GDPR, par le California Consumer Privacy Act (en qualité d’« authorized agent ») et par toute législation équivalente : demandes d’accès, d’effacement, d’opposition et de limitation, relances et réclamations auprès des autorités de contrôle.

Le mandataire s’engage à n’utiliser les données transmises qu’aux fins d’exécution de ce mandat, à les conserver de manière sécurisée et à les supprimer à la fin de la relation contractuelle. Le mandant peut révoquer ce mandat à tout moment depuis son tableau de bord ; la révocation prend effet immédiatement pour les demandes à venir.

Signé électroniquement le ${fmtDate(signedAt)} par ${user.mandate_name}.`;
}
