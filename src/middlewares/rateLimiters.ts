import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 300, 
    standardHeaders: true, 
    legacyHeaders: false 
});

export const authLimiter = rateLimit({ 
    windowMs: 5 * 60 * 1000, 
    max: 20, 
    message: 'Conta temporariamente bloqueada devido a muitas tentativas.', 
    standardHeaders: true, 
    legacyHeaders: false 
});