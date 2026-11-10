// Prints a one-time admin invite for the first account. It never runs wrangler itself: it prints the
// command, and you run it. Usage (Node 24):
//   node scripts/bootstrap-invite.ts            # for the deployed database (--remote)
//   node scripts/bootstrap-invite.ts --local    # for `npm run dev` (add --persist-to <dir> to the wrangler line if dev uses one)
//   add --force to make another admin invite even though an admin exists (account recovery)
import { bootstrapInvite } from '../src/bootstrap.ts'

declare const process: { argv: string[]; env: Record<string, string | undefined> }

const args = process.argv.slice(2)
const local = args.includes('--local')
const force = args.includes('--force')
// Remote: the website's join page. Local: this Worker's own fallback /join page under `npm run dev`.
const base = process.env.PUBLIC_URL ?? (local ? 'http://localhost:8799' : 'https://nexttupp.com')
const { token, sql, expiresAt } = await bootstrapInvite({ force })

console.log(`1. Insert the invite (only its hash is stored${force ? '' : '; does nothing if an admin already exists'}):

   npx wrangler d1 execute nexttupp ${local ? '--local' : '--remote'} --command "${sql}"

2. Then create the admin account with it (single use, expires ${new Date(expiresAt).toISOString()}), either
   in the nexttupp app (profile menu → Account → Join with an invite, paste the code or the link):

   ${token}

   or in a browser:

   ${base}/join?code=${token}

The code is shown only here. An unused bootstrap invite expires after 24 hours, and using one
revokes any other unused bootstrap invites. To cancel it before then:
   npx wrangler d1 execute nexttupp ${local ? '--local' : '--remote'} --command "UPDATE invites SET revoked_at = ${Date.now()} WHERE created_by IS NULL AND used_at IS NULL;"`)
