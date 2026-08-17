// Minimal stub so pure-logic modules that transitively import react-native don't crash.
export const Platform = { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios };
export const Alert = { alert: jest.fn() };
