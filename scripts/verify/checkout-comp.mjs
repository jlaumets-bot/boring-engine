// v708 — a 100%-off promotion code must not demand a card for a €0 checkout, and nothing may make
// a PAID checkout skip the card: if_required is only safe while the session carries no Stripe trial.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(root, 'api', 'create-checkout.js'), 'utf8');
const fails = [];
if (!/'allow_promotion_codes':\s*'true'/.test(src)) fails.push('promotion codes are no longer allowed at checkout');
if (!/'payment_method_collection':\s*'if_required'/.test(src)) fails.push('payment_method_collection is not if_required (a 100%-off code would still demand a card)');
if (/trial_period_days|subscription_data\[trial_/.test(src)) fails.push('a Stripe trial was added: with if_required a trialing subscription would start with NO card — revisit before shipping');
if (fails.length) { fails.forEach(f => console.error('FAIL: ' + f)); process.exit(1); }
console.log('CHECKOUT COMP OK');
