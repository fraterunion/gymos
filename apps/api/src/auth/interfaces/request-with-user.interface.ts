import type { Request } from 'express';
import type { JwtUser } from './jwt-user.type';

export interface RequestWithUser extends Request {
  user: JwtUser;
}
