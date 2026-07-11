// Security settings category (spec 066): the Kratos `password` + `passkey` groups. Split out from
// Profile so credentials live under their own heading.

import { KratosSettingsSections } from '../auth/KratosFlow.tsx';

export function SecuritySection() {
  return <KratosSettingsSections groups={['password', 'passkey']} />;
}
