export const getClientIp = (req: any) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0];
    }
    return req.socket?.remoteAddress || req.ip || '0.0.0.0';
};