import type { Profile } from '../../../shared/types.ts'
import { avatarTone, initial } from '../profiles.ts'

/** A profile's initial on a neutral disc. Size comes from the parent's class. */
export function Avatar ({ profile, className = '' }: { profile: Pick<Profile, 'id' | 'name' | 'avatar'>; className?: string }) {
  return (
    <span className={`avatar tone-${avatarTone(profile)} ${className}`} aria-hidden>
      {initial(profile.name)}
    </span>
  )
}
