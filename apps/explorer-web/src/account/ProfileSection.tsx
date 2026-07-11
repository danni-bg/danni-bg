// Profile settings category (spec 066): the user's identity — avatar + the Kratos `profile` group
// (display name + email). Security (password/passkeys) is its own category.

import { KratosSettingsSections } from '../auth/KratosFlow.tsx';
import { AvatarUpload } from './AvatarUpload.tsx';

export function ProfileSection() {
  return (
    <div className="space-y-6">
      <AvatarUpload />
      <KratosSettingsSections groups={['profile']} />
    </div>
  );
}
