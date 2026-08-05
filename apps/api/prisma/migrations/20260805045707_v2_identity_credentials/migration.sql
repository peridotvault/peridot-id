-- CreateEnum
CREATE TYPE "IdentityStatus" AS ENUM ('active', 'suspended', 'deleted');

-- AlterTable
ALTER TABLE "identities" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "status" "IdentityStatus" NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "username" TEXT,
ADD COLUMN     "usernameChangedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_username_key" ON "profiles"("username");

-- RenameTable (data-preserving)
ALTER TABLE "auth_accounts" RENAME TO "identity_credentials";

-- RenameColumn
ALTER TABLE "identity_credentials" RENAME COLUMN "providerId" TO "providerUserId";

-- AddColumn
ALTER TABLE "identity_credentials" ADD COLUMN     "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- Recreate unique index to match the new column name
DROP INDEX "auth_accounts_provider_providerId_key";
CREATE UNIQUE INDEX "identity_credentials_provider_providerUserId_key" ON "identity_credentials"("provider", "providerUserId");
