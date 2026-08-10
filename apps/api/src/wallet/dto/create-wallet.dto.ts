import { IsString, Length } from "class-validator";
import { WalletCreate } from "@peridot/types";

export class CreateWalletDto implements WalletCreate {
  @IsString()
  @Length(1, 64)
  address!: string;
}
