// config.js — small shared constants that don't belong to any one layer.
//
// The admin account: whoever is signed in as this Matrix user gets folded
// into every applicant's room (see store.js MatrixStore._ensureAdminInvited)
// and can open the Admin dashboard (see admin.js) to review uploaded
// documents across every applicant.

export const ADMIN_USER_ID = "@abc:hyphae.social";
