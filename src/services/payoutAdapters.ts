export interface PayoutProvider {
  send(phone: string, amount: number): Promise<any>;
}

export class OrangeMoneyPayoutProvider implements PayoutProvider {
  async send(phone: string, amount: number): Promise<any> {
    console.log(`[OrangeMoney] Sending $${amount} to ${phone}`);
    // Mock success for V1
    return { success: true, reference: `ORANGE-${Math.floor(Math.random() * 100000)}` };
  }
}

export class MTNMomoPayoutProvider implements PayoutProvider {
  async send(phone: string, amount: number): Promise<any> {
    console.log(`[MTNMomo] Sending $${amount} to ${phone}`);
    // Mock success for V1
    return { success: true, reference: `MTN-${Math.floor(Math.random() * 100000)}` };
  }
}

export function getPayoutProvider(provider: string): PayoutProvider {
  switch (provider) {
    case 'orange_money':
      return new OrangeMoneyPayoutProvider();
    case 'mtn_momo':
      return new MTNMomoPayoutProvider();
    default:
      throw new Error(`Unsupported payout provider: ${provider}`);
  }
}
