import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { SignOptions } from 'jsonwebtoken';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { StudioMemberGuard } from './guards/studio-member.guard';
import { AuthThrottlerGuard } from './guards/auth-throttler.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { StudioAccessController } from './studio-access.controller';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('JWT_ACCESS_TTL', '15m') as SignOptions['expiresIn'],
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, StudioAccessController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    StudioMemberGuard,
    RolesGuard,
    AuthThrottlerGuard,
  ],
  exports: [AuthService, JwtAuthGuard, StudioMemberGuard, RolesGuard],
})
export class AuthModule {}
