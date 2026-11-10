// Prints a one-time admin invite for the first account. It never runs wrangler itself: it prints the
// command, and you run it. Usage (Node 24):
//   node scripts/bootstrap-invite.ts            # for the deployed database (--remote)
//   node scripts/bootstrap-invite.ts --local    # for `npm run dev`
//   add --force to make another admin invite even though an admin exists (account recovery)
import { bootstrapInvite } from '../src/bootstrap.ts'

declare const process: { argv: string[]; env: Record<string, string | undefined> }

const args = process.argv.slice(2)
const local = args.includes('--local')
const force = args.includes('--force')
const base = process.env.PUBLIC_URL ?? (local ? 'http://localhost:8799' : 'https://api.nexttupp.com')
const { token, sql, expiresAt } = await bootstrapInvite({ force })

console.log(`1. Insert the invite (only its hash is stored${force ? '' : '; does nothing if an admin already exists'}):

   npx wrangler d1 execute nexttupp ${local ? '--local' : '--remote'} --command "${sql}"

2. Then open this link and create the admin account (single use, expires ${new Date(expiresAt).toISOString()}):

   ${base}/join#${token}

   or from a terminal:
   curl -X POST ${base}/v1/invites/accept -H 'content-type: application/json' \\
     -d '{"token":"${token}","email":"you@example.com","password":"…","displayName":"You"}'

The token is shown only here. An unused bootstrap invite expires after 24 hours, and using one
revokes any other unused bootstrap invites. To cancel it before then:
   npx wrangler d1 execute nexttupp ${local ? '--local' : '--remote'} --command "UPDATE invites SET revoked_at = ${Date.now()} WHERE created_by IS NULL AND used_at IS NULL;"`)
