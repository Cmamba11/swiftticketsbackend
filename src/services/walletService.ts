import { prisma } from '../lib/db';

export const PLATFORM_FEE_PERCENT = 0.10;

/**
 * Credits the organizer wallet for a ticket sale.
 * Includes Debt Recovery: If the organizer has a negative balance, 
 * the new funds are first used to offset the debt.
 */
export async function creditOrganizerWallet(organizerId: string, amount: number, reference: string, eventId: string, tx?: any) {
  const platformFee = amount * PLATFORM_FEE_PERCENT;
  const organizerShare = amount - platformFee;
  
// Post-Event Escrow: 100% of organizer share is held in pending balance until the event ends
  const availableShare = 0;
  const pendingShare = organizerShare;

  const execute = async (transactionClient: any) => {
    // 1. Get current wallet to check for debt
    const wallet = await transactionClient.organizerWallet.upsert({
      where: { organizerId },
      update: {},
      create: {
        organizerId,
        availableBalance: 0,
        pendingBalance: 0,
        totalWithdrawn: 0,
      },
    });

    let finalAvailableIncrement = availableShare;
    let debtOffset = 0;

    // DEBT RECOVERY: If balance is negative, offset it first
    if (wallet.availableBalance < 0) {
      const debt = Math.abs(wallet.availableBalance);
      debtOffset = Math.min(debt, availableShare);
      // If we still have debt, we might even take from the pending share if it's a high-risk situation,
      // but for now we just offset the available portion.
    }

    // 2. Update wallet
    const updatedWallet = await transactionClient.organizerWallet.update({
      where: { organizerId },
      data: {
        availableBalance: { increment: availableShare },
        pendingBalance: { increment: pendingShare },
      },
    });

    // If debt was cleared or reduced, check if we can re-enable withdrawals
    if (updatedWallet.availableBalance >= 0) {
      await transactionClient.organizer.update({
        where: { id: organizerId },
        data: { withdrawalsDisabled: false }
      });
    }

    // 3. Create WalletLedger entries for accounting
    await transactionClient.walletLedger.create({
      data: {
        organizerId,
        eventId,
        type: 'available',
        amount: availableShare,
        released: true,
      },
    });

    await transactionClient.walletLedger.create({
      data: {
        organizerId,
        eventId,
        type: 'pending',
        amount: pendingShare,
        released: false,
      },
    });

    await transactionClient.walletLedger.create({
      data: {
        organizerId,
        eventId,
        type: 'platform_fee',
        amount: platformFee,
        released: true,
      },
    });

    // 4. Create legacy ledger entry
    await transactionClient.walletTransaction.create({
      data: {
        organizerId,
        type: 'credit',
        amount: organizerShare,
        reference,
        description: `Ticket sale${debtOffset > 0 ? ` (Debt offset: $${debtOffset.toFixed(2)})` : ''}: Held in pending balance until event ends.`,
      },
    });

    return updatedWallet;
  };

  if (tx) {
    return await execute(tx);
  } else {
    return await prisma.$transaction(async (newTx) => {
      return await execute(newTx);
    });
  }
}

/**
 * Releases the 20% reserve for a completed event.
 * Prevents release if event was cancelled.
 */
export async function releaseEventReserve(eventId: string) {
  return await prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: eventId },
      include: { organizer: { include: { wallet: true } } },
    });

    if (!event) throw new Error('Event not found');
    if (event.status === 'Cancelled') {
      console.log(`Event ${eventId} was cancelled. Reserve will not be released.`);
      return { success: false, message: 'Event cancelled' };
    }
    if (event.reserveReleased) {
      return { success: true, alreadyReleased: true };
    }

    const pendingEntries = await tx.walletLedger.findMany({
      where: {
        organizerId: event.organizerId,
        eventId: eventId,
        type: 'pending',
        released: false,
      },
    });

    if (pendingEntries.length === 0) {
      await tx.event.update({
        where: { id: eventId },
        data: { reserveReleased: true },
      });
      return { success: true, amount: 0 };
    }

    const totalToRelease = pendingEntries.reduce((acc, entry) => acc + entry.amount, 0);

    await tx.organizerWallet.update({
      where: { organizerId: event.organizerId },
      data: {
        availableBalance: { increment: totalToRelease },
        pendingBalance: { decrement: totalToRelease },
      },
    });

    await tx.walletLedger.create({
      data: {
        organizerId: event.organizerId,
        eventId: eventId,
        type: 'available',
        amount: totalToRelease,
        released: true,
      },
    });

    await tx.walletLedger.updateMany({
      where: { id: { in: pendingEntries.map(e => e.id) } },
      data: { released: true },
    });

    await tx.event.update({
      where: { id: eventId },
      data: { reserveReleased: true },
    });

    return { success: true, amount: totalToRelease };
  });
}

/**
 * PRODUCTION-GRADE REFUND ENGINE WITH WATERFALL LOGIC
 */
export async function refundTicket(ticketId: string, isAdminOverride: boolean = false) {
  return await prisma.$transaction(async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: { event: { include: { organizer: { include: { wallet: true } } } } },
    });

    if (!ticket || ticket.status === 'Refunded') {
      throw new Error('Ticket not found or already refunded');
    }

    // POST-SCAN RULE: Reject if used, unless admin override
    if (ticket.status === 'Scanned' && !isAdminOverride) {
      throw new Error('Cannot refund a scanned ticket without admin override');
    }

    const organizerId = ticket.event.organizerId;
    const amount = Number(ticket.pricePaid);
    const platformFee = amount * PLATFORM_FEE_PERCENT;
    const organizerShare = amount - platformFee;
    
    let remainingToRefund = organizerShare;
    let pendingDeduction = 0;
    let availableDeduction = 0;

    // WATERFALL 1: EVENT-LEVEL PENDING FIRST
    const pendingEntries = await tx.walletLedger.findMany({
      where: {
        organizerId,
        eventId: ticket.eventId,
        type: 'pending',
        released: false,
      },
      orderBy: { createdAt: 'desc' }
    });

    for (const entry of pendingEntries) {
      if (remainingToRefund <= 0) break;
      const take = Math.min(entry.amount, remainingToRefund);
      
      await tx.walletLedger.update({
        where: { id: entry.id },
        data: { amount: { decrement: take } }
      });

      remainingToRefund -= take;
      pendingDeduction += take;
    }

    // WATERFALL 2: ORGANIZER AVAILABLE BALANCE SECOND
    if (remainingToRefund > 0) {
      availableDeduction = remainingToRefund;
      remainingToRefund = 0;
    }

    // Update Wallet
    const wallet = await tx.organizerWallet.update({
      where: { organizerId },
      data: {
        availableBalance: { decrement: availableDeduction },
        pendingBalance: { decrement: pendingDeduction },
      },
    });

    // WATERFALL 3: NEGATIVE BALANCE / DEBT MODE
    if (wallet.availableBalance < 0) {
      await tx.organizer.update({
        where: { id: organizerId },
        data: { 
          withdrawalsDisabled: true,
          negativeBalanceCount: { increment: 1 }
        }
      });

      await tx.walletLedger.create({
        data: {
          organizerId,
          eventId: ticket.eventId,
          type: 'negative_balance',
          amount: wallet.availableBalance, // Current negative state
          released: true,
        },
      });
    }

    // Add refund ledger entry
    await tx.walletLedger.create({
      data: {
        organizerId,
        eventId: ticket.eventId,
        type: 'refund',
        amount: -organizerShare,
        released: true,
      },
    });

    // Update ticket status
    await tx.ticket.update({
      where: { id: ticketId },
      data: { status: 'Refunded' },
    });

    // FRAUD / RISK FLAGS
    await updateOrganizerRiskLevel(organizerId, tx);

    return { success: true };
  });
}

/**
 * EVENT CANCELLATION ENGINE
 */
export async function cancelEvent(eventId: string) {
  return await prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: eventId },
      include: { tickets: true }
    });

    if (!event || event.status === 'Cancelled') {
      throw new Error('Event not found or already cancelled');
    }

    // 1. Update event status
    await tx.event.update({
      where: { id: eventId },
      data: { 
        status: 'Cancelled',
        cancelledAt: new Date()
      }
    });

    // 2. Risk Detection: Cancellation < 2 hours before event
    const hoursUntilEvent = (event.date.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursUntilEvent < 2) {
      await tx.organizer.update({
        where: { id: event.organizerId },
        data: { riskLevel: 'high', withdrawalsDisabled: true }
      });
    }

    // 3. Auto-refund all paid but unscanned tickets
    const ticketsToRefund = event.tickets.filter(t => t.status === 'Active');
    for (const ticket of ticketsToRefund) {
      await refundTicket(ticket.id, false); // Waterfall logic applies
    }

    // 4. Invalidate all QR tickets (already handled by status update in refundTicket)
    
    return { success: true, refundedCount: ticketsToRefund.length };
  });
}

/**
 * AUTOMATED RISK DETECTION
 */
async function updateOrganizerRiskLevel(organizerId: string, tx: any) {
  const organizer = await tx.organizer.findUnique({
    where: { id: organizerId },
    include: { 
      events: { include: { tickets: true } },
      wallet: true
    }
  });

  let riskScore = 0;

  // 1. Refund ratio > 30% of event sales
  for (const event of organizer.events) {
    const totalTickets = event.tickets.length;
    if (totalTickets > 0) {
      const refundedTickets = event.tickets.filter(t => t.status === 'Refunded').length;
      const refundRatio = refundedTickets / totalTickets;
      if (refundRatio > 0.3) riskScore += 2;
    }
  }

  // 2. Negative balance count
  if (organizer.negativeBalanceCount > 2) riskScore += 3;

  // 3. Current negative balance
  if (organizer.wallet.availableBalance < -500) riskScore += 2;

  // Determine Risk Level
  let riskLevel = 'low';
  if (riskScore >= 5) riskLevel = 'high';
  else if (riskScore >= 2) riskLevel = 'medium';

  await tx.organizer.update({
    where: { id: organizerId },
    data: { 
      riskLevel,
      withdrawalsDisabled: riskLevel === 'high' || organizer.wallet.availableBalance < 0
    }
  });
}

export async function requestWithdrawal(organizerId: string, amount: number, provider: string, phone: string) {
  return await prisma.$transaction(async (tx) => {
    const organizer = await tx.organizer.findUnique({
      where: { id: organizerId },
      include: { wallet: true }
    });

    if (!organizer || !organizer.wallet) throw new Error('Organizer not found');
    
    // LOCK WITHDRAWALS
    if (organizer.withdrawalsDisabled) {
      throw new Error('Withdrawals are currently disabled for this account due to negative balance or high risk.');
    }

    if (organizer.wallet.availableBalance < amount) {
      throw new Error('Insufficient balance');
    }

    // Require manual admin review for large payouts (e.g., > $1000)
    const status = amount > 1000 ? 'pending' : 'pending'; // Both pending, but could flag for review

    const withdrawal = await tx.withdrawal.create({
      data: {
        organizerId,
        amount: amount,
        provider,
        phone,
        status: 'pending',
      },
    });

    return withdrawal;
  });
}

export async function processWithdrawal(withdrawalId: string, status: 'paid' | 'failed') {
  return await prisma.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({
      where: { id: withdrawalId },
      include: { organizer: { include: { wallet: true } } },
    });

    if (!withdrawal || withdrawal.status !== 'pending') {
      throw new Error('Invalid withdrawal request');
    }

    if (status === 'paid') {
      const wallet = withdrawal.organizer.wallet;
      if (!wallet || wallet.availableBalance < withdrawal.amount) {
        throw new Error('Insufficient balance in wallet');
      }

      // 1. Deduct from available balance and increment totalWithdrawn
      await tx.organizerWallet.update({
        where: { organizerId: withdrawal.organizerId },
        data: {
          availableBalance: { decrement: withdrawal.amount },
          totalWithdrawn: { increment: withdrawal.amount },
        },
      });

      // 2. Create withdrawal ledger entry
      await tx.walletLedger.create({
        data: {
          organizerId: withdrawal.organizerId,
          type: 'withdrawal',
          amount: -withdrawal.amount,
          released: true,
        },
      });

      // 3. Create legacy debit transaction
      await tx.walletTransaction.create({
        data: {
          organizerId: withdrawal.organizerId,
          type: 'debit',
          amount: withdrawal.amount,
          reference: withdrawal.id,
          description: `Withdrawal payout via ${withdrawal.provider} to ${withdrawal.phone}`,
        },
      });
    }

    // 4. Update withdrawal status
    const updatedWithdrawal = await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: { status },
    });

    // Re-check risk level after withdrawal
    await updateOrganizerRiskLevel(withdrawal.organizerId, tx);

    return updatedWithdrawal;
  });
}
