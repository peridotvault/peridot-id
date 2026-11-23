// Screen registry for the hand-rolled shell (App.tsx is the composer, this is
// the route table). Each page group registers its own screens; the root only
// aggregates immediate child groups — the one place the shell imports pages.
import { activityPages } from "./activity/route";
import { authPages } from "./auth/route";
import { chainPages } from "./chain/route";
import { embedPages } from "./embed/route";
import { fiatPages } from "./fiat/route";
import { homePages } from "./home/route";
import { identityPages } from "./identity/route";

export const pages = {
  ...activityPages,
  ...authPages,
  ...chainPages,
  ...embedPages,
  ...fiatPages,
  ...homePages,
  ...identityPages,
};
