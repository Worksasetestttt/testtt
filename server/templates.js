// Modèles d'e-mails (français + anglais pour les courtiers hors francophonie).
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const COMPANY = process.env.COMPANY_NAME || 'Oubli SAS';
const COMPANY_ADDR = process.env.COMPANY_ADDRESS || '12 rue des Capucins, 69001 Lyon, France';
export const MANDATE_VERSION = '2026-10';

const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const list = (arr) => (arr && arr.length ? arr.join(', ') : '—');
const j = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export function identityBlock(profile) {
  const lines = [
    `Nom : ${profile.last_name.toUpperCase()}`,
    `Prénom : ${profile.first_name}`,
    profile.birth_date ? `Date de naissance : ${fmtDate(profile.birth_date)}` : null,
    `Pays de résidence : ${profile.country}`,
    `Adresses e-mail : ${list(j(profile.emails))}`,
    `Téléphones : ${list(j(profile.phones))}`,
    `Adresses postales : ${list(j(profile.addresses))}`,
    j(profile.aliases).length ? `Autres noms utilisés : ${list(j(profile.aliases))}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function removalRequest({ profile, broker, user, ref, mandateDate }) {
  const rgpd = broker.legal_basis !== 'ccpa';
  const ccpa = broker.legal_basis !== 'rgpd';
  const subject = `Demande d'effacement de données personnelles — ${rgpd ? 'art. 17 RGPD' : 'CCPA'} [${ref}]`;
  const fr = `Madame, Monsieur,

Au nom et pour le compte de la personne identifiée ci-dessous, en vertu du mandat qui nous a été confié le ${fmtDate(mandateDate)} (disponible sur demande), nous vous demandons :

1. de confirmer si vous détenez des données personnelles la concernant (article 15 du RGPD) ;
2. de supprimer l'ensemble de ces données, y compris les profils, agrégats, identifiants et copies de sauvegarde (article 17 du RGPD, « droit à l'effacement ») ;
3. de cesser tout traitement à des fins de prospection ou de profilage (article 21 §2 du RGPD, opposition absolue et sans motif) ;
4. de ne pas réintégrer ces données ultérieurement et de nous indiquer les tiers auxquels elles ont été transmises (article 19 du RGPD).

Identité de la personne concernée :
${identityBlock(profile)}

Conformément à l'article 12 §3 du RGPD, nous attendons votre réponse dans un délai d'un mois à compter de la réception de ce message. À défaut, une réclamation pourra être déposée auprès de la CNIL (ou de l'autorité de contrôle compétente).

Merci de répondre à ce message en conservant la référence [${ref}] dans l'objet.

Cordialement,
${COMPANY}, mandataire
${COMPANY_ADDR}
Référence : ${ref}`;

  const en = `Dear Sir or Madam,

On behalf of the data subject identified below, under a written authorization granted to us on ${new Date(mandateDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} (available on request), we request that you:

1. confirm whether you hold personal data relating to this person;
2. delete all such data, including profiles, derived data, identifiers and backups${rgpd ? ' (Article 17 GDPR, right to erasure)' : ''}${ccpa ? ' (California Consumer Privacy Act, Cal. Civ. Code § 1798.105, right to delete)' : ''};
3. stop any processing for direct marketing or profiling purposes${rgpd ? ' (Article 21(2) GDPR)' : ''}${ccpa ? ' and do not sell or share this personal information (Cal. Civ. Code § 1798.120)' : ''};
4. refrain from re-adding this data in the future and tell us which third parties received it.

Data subject:
${identityBlock(profile)}

${rgpd ? 'Under Article 12(3) GDPR you must respond within one month of receipt.' : 'Under the CCPA you must respond within 45 days of receipt.'} Please keep the reference [${ref}] in the subject line of your reply.

Kind regards,
${COMPANY}, authorized agent
${COMPANY_ADDR}
Reference: ${ref}`;

  return { subject, text: broker.jurisdiction === 'EU' ? `${fr}\n\n— English version below —\n\n${en}` : `${en}\n\n— Version française ci-dessous —\n\n${fr}` };
}

export function followUp({ broker, ref, sentAt }) {
  const rgpd = broker.legal_basis !== 'ccpa';
  return {
    subject: `Relance — demande d'effacement sans réponse [${ref}]`,
    text: `Madame, Monsieur,

Notre demande d'effacement référencée [${ref}], envoyée le ${fmtDate(sentAt)}, est restée sans réponse à l'expiration du délai légal ${rgpd ? "d'un mois (article 12 §3 du RGPD)" : 'de 45 jours (CCPA)'}.

Nous vous demandons de confirmer la suppression des données sous 8 jours. À défaut, nous saisirons l'autorité de contrôle compétente${rgpd ? ' (CNIL)' : ' (California Privacy Protection Agency)'}.

— Reminder: our erasure request [${ref}] sent on ${new Date(sentAt).toLocaleDateString('en-GB')} received no answer within the statutory period. Please confirm deletion within 8 days; otherwise a complaint will be filed with the supervisory authority.

${COMPANY}, mandataire — Référence : ${ref}`,
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
L'équipe Oubli`,
  };
}

export function actionRequiredMail({ broker, ref }) {
  return {
    subject: `Action requise — ${broker.name} demande une vérification [${ref}]`,
    text: `Bonjour,

${broker.name} demande une vérification avant de supprimer vos données (généralement un clic sur un lien de confirmation ou une pièce d'identité partielle). Rendez-vous sur votre tableau de bord pour voir la marche à suivre :
${APP_URL}/app/#dashboard

Référence : ${ref}
L'équipe Oubli`,
  };
}

export function mandateText({ user, profile, signedAt }) {
  return `MANDAT DE REPRÉSENTATION — version ${MANDATE_VERSION}

Mandant : ${profile.first_name} ${profile.last_name.toUpperCase()} (${user.email})
Mandataire : ${COMPANY}, ${COMPANY_ADDR}

Le mandant autorise le mandataire à exercer en son nom, auprès de tout courtier en données, site de recherche de personnes, annuaire ou responsable de traitement, les droits prévus par les articles 15, 17, 19 et 21 du Règlement (UE) 2016/679 (RGPD), par le UK GDPR, par le California Consumer Privacy Act et par toute législation équivalente : demandes d'accès, d'effacement, d'opposition et de limitation, relances et réclamations auprès des autorités de contrôle.

Le mandataire s'engage à n'utiliser les données transmises qu'aux fins d'exécution de ce mandat, à les conserver chiffrées et à les supprimer à la fin de la relation contractuelle. Le mandant peut révoquer ce mandat à tout moment depuis son tableau de bord ; la révocation prend effet immédiatement pour les demandes à venir.

Signé électroniquement le ${fmtDate(signedAt)} par ${user.mandate_name}.`;
}
