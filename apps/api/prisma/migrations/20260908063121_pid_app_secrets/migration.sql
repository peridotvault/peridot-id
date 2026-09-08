-- AlterTable
ALTER TABLE "pid_apps" ADD COLUMN     "clientSecretCreatedAt" TIMESTAMP(3),
ADD COLUMN     "clientSecretHash" TEXT,
ADD COLUMN     "clientSecretPrefix" TEXT;
