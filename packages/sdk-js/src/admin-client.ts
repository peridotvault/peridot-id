import type {
  ApiError,
  Chain,
  ChainContract,
  ChainPreview,
  CreateChainInput,
  CreateTokenInput,
  Token,
  TokenDeployment,
  TokenPreview,
  UpdateChainInput,
  UpdateTokenDeploymentInput,
  UpdateTokenInput,
  UpsertContractInput,
} from "@peridotvault/pid-types";
import type { PeridotClient } from "./client.js";

/** Admin chain-registry management (role-gated server-side; hidden in UI for users). */
export class PeridotAdmin {
  constructor(private client: PeridotClient) {}

  async chains(): Promise<Chain[] | ApiError> {
    const res = await this.client.get<Chain[]>("/v1/admin/chains");
    return res.data;
  }

  async createChain(input: CreateChainInput): Promise<Chain | ApiError> {
    const res = await this.client.post<Chain>("/v1/admin/chains", input);
    return res.data;
  }

  async updateChain(id: string, input: UpdateChainInput): Promise<Chain | ApiError> {
    const res = await this.client.patch<Chain>(`/v1/admin/chains/${id}`, input);
    return res.data;
  }

  async upsertContract(chainId: string, input: UpsertContractInput): Promise<ChainContract | ApiError> {
    const res = await this.client.post<ChainContract>(`/v1/admin/chains/${chainId}/contracts`, input);
    return res.data;
  }

  async uploadChainLogo(id: string, file: File | Blob): Promise<Chain | ApiError> {
    const form = new FormData();
    form.append("logo", file);
    const res = await this.client.postForm<Chain>(`/v1/admin/chains/${id}/logo`, form);
    return res.data;
  }

  async tokens(): Promise<Token[] | ApiError> {
    const res = await this.client.get<Token[]>("/v1/admin/tokens");
    return res.data;
  }

  async previewToken(input: { chainNamespace: string; chainReference: string; mint: string }): Promise<TokenPreview | ApiError> {
    const res = await this.client.post<TokenPreview>("/v1/admin/tokens/preview", input);
    return res.data;
  }

  async previewChain(input: { chainNamespace: string; reference: string; rpcUrl: string }): Promise<ChainPreview | ApiError> {
    const res = await this.client.post<ChainPreview>("/v1/admin/chains/preview", input);
    return res.data;
  }

  async createToken(input: CreateTokenInput): Promise<Token | ApiError> {
    const res = await this.client.post<Token>("/v1/admin/tokens", input);
    return res.data;
  }

  async updateToken(id: string, input: UpdateTokenInput): Promise<Token | ApiError> {
    const res = await this.client.patch<Token>(`/v1/admin/tokens/${id}`, input);
    return res.data;
  }

  async updateTokenDeployment(deploymentId: string, input: UpdateTokenDeploymentInput): Promise<TokenDeployment | ApiError> {
    const res = await this.client.patch<TokenDeployment>(`/v1/admin/tokens/deployments/${deploymentId}`, input);
    return res.data;
  }

  async uploadTokenLogo(id: string, file: File | Blob): Promise<Token | ApiError> {
    const form = new FormData();
    form.append("logo", file);
    const res = await this.client.postForm<Token>(`/v1/admin/tokens/${id}/logo`, form);
    return res.data;
  }
}
