import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { generateToken } from '../lib/auth.js';
import { validationError, unauthorized, asyncHandler } from '../middleware/errorHandler.js';
import { info } from '../utils/logger.js';
import { getConfig } from '../config/env.js';
import { verifyIdToken } from '../services/oidcProvider.js';

export const authRouter = Router();

// Schema for session creation supporting OIDC token exchange and shared-secret fallback
const SessionRequestSchema = z.object({
  address: z.string().optional(),
  role: z.enum(['operator', 'viewer']).optional().default('viewer'),
  idToken: z.string().optional(),
}).refine(data => {
  // If idToken is not provided, address is required.
  if (!data.idToken && (!data.address || data.address.trim() === '')) {
    return false;
  }
  return true;
}, {
  message: 'Stellar address is required when idToken is not provided',
  path: ['address'],
});

/**
 * @openapi
 * /api/auth/session:
 *   post:
 *     summary: Create a new session (get JWT)
 *     description: |
 *       Issues a JWT for a dashboard client. 
 *       If OIDC is configured and an ID token is provided, uses OIDC exchange.
 *       Otherwise, falls back to the static shared-secret path.
 *     tags:
 *       - auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *                 description: Stellar account address
 *               role:
 *                 type: string
 *                 enum: [operator, viewer]
 *                 default: viewer
 *               idToken:
 *                 type: string
 *                 description: External OIDC ID token
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 */
authRouter.post(
  '/session',
  asyncHandler(async (req: Request, res: Response) => {
    const result = SessionRequestSchema.safeParse(req.body);
    const requestId = req.id ?? req.correlationId;

    if (!result.success) {
      throw validationError('Invalid session request', result.error.format());
    }

    const { address, role, idToken } = result.data;
    const config = getConfig();

    let targetAddress = address;
    let targetRole = role;

    if (idToken) {
      if (!config.oidcIssuerUrl) {
        throw validationError('OIDC authentication is not configured on this server');
      }

      try {
        const verified = await verifyIdToken(idToken);
        if (!targetAddress) {
          targetAddress = verified.address;
        }
        if (!req.body.role) {
          targetRole = verified.role;
        }
      } catch (err) {
        throw unauthorized(`OIDC token validation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!targetAddress) {
      throw validationError('Stellar address is required');
    }

    const token = generateToken({ address: targetAddress, role: targetRole as 'operator' | 'viewer' });

    info('Session created', { address: targetAddress, role: targetRole, requestId, authMethod: idToken ? 'oidc' : 'shared-secret' });

    res.json({
      token,
      user: { address: targetAddress, role: targetRole },
    });
  })
);

