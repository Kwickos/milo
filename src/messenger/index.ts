import { LoopMessageMessenger } from './loopmessage';
import { ConsoleMessenger } from './console';
import { env } from '../config';
import type { Messenger } from './types';

/** Canal actif, choisi par MILO_CHANNEL. Pour changer de fournisseur iMessage, on remplace ici. */
export const messenger: Messenger =
  env.MILO_CHANNEL === 'console' ? new ConsoleMessenger() : new LoopMessageMessenger();

export type { Messenger, InboundMessage } from './types';
