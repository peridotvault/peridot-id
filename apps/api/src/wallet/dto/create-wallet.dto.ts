import { IsString, Length } from "class-validator";
import { WalletCreate } from "@peridotvault/pid-types";

export class CreateWalletDto implements WalletCreate {
  @IsString()
  @Length(1, 64)
  address!: string;
}
