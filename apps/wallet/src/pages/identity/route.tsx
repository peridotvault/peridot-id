import { AppConnections } from "./AppConnections";
import { Chains } from "./Chains";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { EditProfile } from "./EditProfile";
import { Passkey } from "./Passkey";
import { Profile } from "./Profile";
import { Sessions } from "./Sessions";
import { Settings } from "./Settings";

export const identityPages = {
  passkey: Passkey,
  chains: Chains,
  settings: Settings,
  profile: Profile,
  "edit-profile": EditProfile,
  sessions: Sessions,
  connected: ConnectedAccounts,
  "app-connections": AppConnections,
};
