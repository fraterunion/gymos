export interface JwtAccessPayload {
  sub: string;
  email: string;
  platformRole: string | null;
}
