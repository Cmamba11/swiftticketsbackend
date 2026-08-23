import express from "express";
import bcrypt from "bcrypt";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

import { prisma } from "./src/lib/db";

import {
  creditOrganizerWallet,
  releaseEventReserve,
  requestWithdrawal,
  processWithdrawal,
  refundTicket,
  cancelEvent,
} from "./src/services/walletService";

import { processStripePayment } from "./src/services/stripeService";

import {
  generateTicketQrDataUrl,
  sendEmailNotification,
  sendSmsNotification,
} from "./src/services/notificationService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // ============================================================
  // AUTHENTICATION
  // ============================================================

  // -------------------------
  // REGISTER
  // -------------------------
  app.post("/api/auth/register", async (req, res) => {
    const {
      name,
      email,
      phone,
      password,
    } = req.body;

    try {
      console.log("REGISTER ATTEMPT:", {
        name,
        email,
        phone,
      });

      if (!name || !password) {
        return res.status(400).json({
          error: "Name and password are required",
        });
      }

      if (!email && !phone) {
        return res.status(400).json({
          error: "Email or phone number is required",
        });
      }

      if (String(password).length < 6) {
        return res.status(400).json({
          error: "Password must be at least 6 characters",
        });
      }

      const normalizedEmail = email
        ? String(email).trim().toLowerCase()
        : null;

      const normalizedPhone = phone
        ? String(phone).trim()
        : null;

      // Check if email or phone is already registered.
      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [
            ...(normalizedEmail
              ? [{ email: normalizedEmail }]
              : []),
            ...(normalizedPhone
              ? [{ phone: normalizedPhone }]
              : []),
          ],
        },
      });

      if (existingUser) {
        if (
          normalizedEmail &&
          existingUser.email === normalizedEmail
        ) {
          return res.status(409).json({
            error: "An account with this email already exists",
          });
        }

        if (
          normalizedPhone &&
          existingUser.phone === normalizedPhone
        ) {
          return res.status(409).json({
            error: "An account with this phone number already exists",
          });
        }

        return res.status(409).json({
          error: "An account with these details already exists",
        });
      }

      // Hash password before storing it.
      const passwordHash = await bcrypt.hash(
        String(password),
        12
      );

      // New accounts are Customers by default.
      // Do NOT accept role from the request because that would
      // allow someone to register themselves as Admin.
      const user = await prisma.user.create({
        data: {
          name: String(name).trim(),
          email: normalizedEmail,
          phone: normalizedPhone,
          passwordHash,
          role: "Customer",
        },
      });

      console.log("USER REGISTERED:", user.id);

      return res.status(201).json({
        success: true,
        message: "Account created successfully",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      });
    } catch (err: any) {
      console.error("========== REGISTER ERROR ==========");
      console.error(err);
      console.error("====================================");

      // Prisma unique constraint
      if (err?.code === "P2002") {
        return res.status(409).json({
          error: "Email or phone number is already registered",
        });
      }

      return res.status(500).json({
        error: err.message || "Registration failed",
      });
    }
  });

  // -------------------------
  // LOGIN
  // -------------------------
  app.post("/api/auth/login", async (req, res) => {
    const { identifier, password } = req.body;

    try {
      console.log("LOGIN ATTEMPT:", identifier);

      if (!identifier || !password) {
        return res.status(400).json({
          error: "Email/phone and password are required",
        });
      }

      const normalizedIdentifier = String(identifier).trim();

      const user = await prisma.user.findFirst({
        where: {
          OR: [
            {
              email: normalizedIdentifier.toLowerCase(),
            },
            {
              phone: normalizedIdentifier,
            },
          ],
        },
      });

      console.log("USER FOUND:", !!user);

      if (!user) {
        return res.status(401).json({
          error: "Invalid email/phone or password",
        });
      }

      if (!user.passwordHash) {
        return res.status(401).json({
          error: "This account does not have a password set",
        });
      }

      console.log(
        "PASSWORD HASH EXISTS:",
        !!user.passwordHash
      );

      const passwordValid = await bcrypt.compare(
        String(password),
        user.passwordHash
      );

      console.log("PASSWORD VALID:", passwordValid);

      if (!passwordValid) {
        return res.status(401).json({
          error: "Invalid email/phone or password",
        });
      }

      return res.json({
        success: true,
        user: {
          uid: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      });
    } catch (err: any) {
      console.error("========== LOGIN ERROR ==========");
      console.error(err);
      console.error("=================================");

      return res.status(500).json({
        error: err.message || "Login failed",
      });
    }
  });

  // ============================================================
  // HEALTH
  // ============================================================

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      message: "Swift Tickets API is running",
    });
  });

  // ============================================================
  // EVENTS API
  // ============================================================

  app.get("/api/events", async (req, res) => {
    try {
      const events = await prisma.event.findMany({
        where: {
          status: "Published",
        },
        include: {
          ticketTypes: true,
        },
      });

      res.json(events);
    } catch (err: any) {
      console.error("Error fetching events:", err);

      res.status(500).json({
        error: err.message,
      });
    }
  });

  app.get("/api/events/:id", async (req, res) => {
    const { id } = req.params;

    try {
      const event = await prisma.event.findUnique({
        where: { id },
        include: {
          ticketTypes: true,
        },
      });

      if (!event) {
        return res.status(404).json({
          error: "Event not found",
        });
      }

      res.json(event);
    } catch (err: any) {
      res.status(500).json({
        error: err.message,
      });
    }
  });

  // ============================================================
  // ORGANIZER EVENTS
  // ============================================================

  app.get("/api/organizer/events/:userId", async (req, res) => {
    const { userId } = req.params;

    try {
      let organizer = await prisma.organizer.findUnique({
        where: { userId },
        include: {
          events: {
            include: {
              ticketTypes: true,
            },
          },
        },
      });

      if (!organizer) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
        });

        if (user) {
          organizer = await prisma.organizer.create({
            data: {
              userId: user.id,
              name: user.name || "Event Organizer",
              email: user.email,
              phone: user.phone || "",
              payoutProvider: "orange_money",
              payoutNumber: user.phone || "",
              wallet: {
                create: {
                  availableBalance: 0,
                  pendingBalance: 0,
                },
              },
            },
            include: {
              events: {
                include: {
                  ticketTypes: true,
                },
              },
            },
          });
        }
      }

      res.json(organizer?.events || []);
    } catch (err: any) {
      res.status(500).json({
        error: err.message,
      });
    }
  });

  // ============================================================
  // ORGANIZER ANALYTICS
  // ============================================================

  app.get("/api/organizer/analytics/:eventId", async (req, res) => {
    const { eventId } = req.params;

    try {
      const tickets = await prisma.ticket.findMany({
        where: {
          eventId,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      const revenue = tickets.reduce(
        (acc, t) => acc + Number(t.pricePaid),
        0
      );

      const ticketsSold = tickets.length;

      const scannedTickets = tickets.filter(
        (t) => t.status === "Scanned"
      ).length;

      const attendanceRate =
        ticketsSold > 0
          ? Number(
              ((scannedTickets / ticketsSold) * 100).toFixed(1)
            )
          : 0;

      res.json({
        ticketsSold,
        revenue,
        attendanceRate,
        conversionRate: 0,
        recentTickets: tickets.slice(0, 10),
      });
    } catch (err: any) {
      res.status(500).json({
        error: err.message,
      });
    }
  });

  // ============================================================
  // CREATE EVENT
  // ============================================================

  app.post("/api/events", async (req, res) => {
    const {
      title,
      description,
      date,
      endDate,
      location,
      organizerId,
      category,
      imageUrl,
      ticketTypes,
    } = req.body;

    try {
      if (!title || !date || !location || !organizerId) {
        return res.status(400).json({
          error:
            "Title, date, location, and organizerId are required",
        });
      }

      if (
        !Array.isArray(ticketTypes) ||
        ticketTypes.length === 0
      ) {
        return res.status(400).json({
          error: "At least one ticket type is required",
        });
      }

      let organizer = await prisma.organizer.findUnique({
        where: {
          userId: organizerId,
        },
        include: {
          wallet: true,
        },
      });

      if (!organizer) {
        const user = await prisma.user.findUnique({
          where: {
            id: organizerId,
          },
        });

        if (!user) {
          return res.status(400).json({
            error:
              "Organizer user account not found. Please sign in or create an account first.",
          });
        }

        organizer = await prisma.organizer.create({
          data: {
            userId: user.id,
            name: user.name || "Event Organizer",
            email: user.email,
            phone: user.phone || "",
            payoutProvider: "orange_money",
            payoutNumber: user.phone || "",
            wallet: {
              create: {
                availableBalance: 0,
                pendingBalance: 0,
              },
            },
          },
          include: {
            wallet: true,
          },
        });
      }

      const event = await prisma.event.create({
        data: {
          title,
          description,
          date: new Date(date),
          endDate: endDate
            ? new Date(endDate)
            : null,
          location,
          organizerId: organizer.id,
          category,
          imageUrl,
          status: "Published",

          ticketTypes: {
            create: ticketTypes.map((t: any) => ({
              name: String(t.name),
              price: Number(t.price) || 0,
              capacity: Number(t.capacity) || 0,
            })),
          },
        },

        include: {
          ticketTypes: true,
        },
      });

      res.status(201).json(event);
    } catch (err: any) {
      console.error("Error creating event:", err);

      res.status(500).json({
        error: err.message,
      });
    }
  });

  // ============================================================
  // CANCEL EVENT
  // ============================================================

  app.post("/api/events/:id/cancel", async (req, res) => {
    const { id } = req.params;

    try {
      const event = await prisma.event.findUnique({
        where: {
          id,
        },
      });

      if (!event) {
        return res.status(404).json({
          error: "Event not found",
        });
      }

      if (event.status === "Cancelled") {
        return res.status(400).json({
          error: "Event is already cancelled",
        });
      }

      const result = await cancelEvent(id);

      res.json({
        success: true,
        message:
          "Event cancelled and eligible tickets refunded.",
        result,
      });
    } catch (err: any) {
      console.error("Cancel event error:", err);

      res.status(500).json({
        error: err.message,
      });
    }
  });

  // ============================================================
  // STRIPE PAYMENT
  // ============================================================

  app.post(
    "/api/stripe/process-payment",
    async (req, res) => {
      const {
        amount,
        cardNumber,
        expMonth,
        expYear,
        cvc,
        cardHolderName,
        attendeeEmail,
        eventTitle,
      } = req.body;

      try {
        const paymentResult =
          await processStripePayment({
            amount: Number(amount),
            cardNumber: String(cardNumber || ""),
            expMonth: String(expMonth || "12"),
            expYear: String(expYear || "28"),
            cvc: String(cvc || "123"),
            cardHolderName,
            attendeeEmail,
            eventTitle,
          });

        res.json(paymentResult);
      } catch (err: any) {
        console.error(
          "Stripe Payment Error:",
          err
        );

        res.status(400).json({
          error:
            err.message ||
            "Payment authorization failed",
        });
      }
    }
  );

  // ============================================================
  // BOOKINGS
  // ============================================================

  app.post("/api/bookings", async (req, res) => {
  const {
    eventId,
    ticketType,
    attendeeName,
    attendeeEmail,
    attendeePhone,
    pricePaid,
    userId,
    uid,
    quantity = 1,
    paymentProvider = "orange_money",
  } = req.body;

  // Support both uid and userId
  const resolvedUserId = userId || uid || null;

  console.log("BOOKING USER:", {
    userId,
    uid,
    resolvedUserId,
    attendeeEmail,
    attendeeName,
    paymentProvider,
    quantity,
  });

  const numQuantity = Math.max(
    1,
    parseInt(String(quantity), 10) || 1
  );

  try {
    const totalPrice = Number(pricePaid);

    if (!eventId || !ticketType) {
      return res.status(400).json({
        error: "Event and ticket type are required",
      });
    }

    if (
      !Number.isFinite(totalPrice) ||
      totalPrice < 0
    ) {
      return res.status(400).json({
        error: "Invalid ticket price",
      });
    }

    if (!attendeeEmail) {
      return res.status(400).json({
        error: "Attendee email is required",
      });
    }

    const singleTicketPricePaid =
      totalPrice / numQuantity;

    const result = await prisma.$transaction(
      async (tx) => {
        const createdTickets: any[] = [];

        // --------------------------------------------------
        // FIND OR CREATE CUSTOMER
        // --------------------------------------------------

        let customerId: string | null = null;

        if (resolvedUserId) {
          const existingUser =
            await tx.user.findUnique({
              where: {
                id: resolvedUserId,
              },
            });

          if (existingUser) {
            customerId = existingUser.id;
          } else {
            const newUser =
              await tx.user.create({
                data: {
                  id: resolvedUserId,
                  name:
                    attendeeName ||
                    "Customer",
                  email: attendeeEmail,
                  role: "Customer",
                  phone:
                    attendeePhone ||
                    undefined,
                },
              });

            customerId = newUser.id;
          }
        } else {
          // If no uid was supplied, try to find
          // the customer by email.
          const existingUser =
            await tx.user.findUnique({
              where: {
                email: attendeeEmail,
              },
            });

          if (existingUser) {
            customerId = existingUser.id;
          } else {
            const newUser =
              await tx.user.create({
                data: {
                  name:
                    attendeeName ||
                    "Customer",
                  email: attendeeEmail,
                  role: "Customer",
                  phone:
                    attendeePhone ||
                    undefined,
                },
              });

            customerId = newUser.id;
          }
        }

        // --------------------------------------------------
        // CREATE TICKETS
        // --------------------------------------------------

        const baseTicketCode =
          `${String(ticketType)
            .toUpperCase()
            .replace(/\s+/g, "-")}-${Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase()}`;

        for (
          let i = 0;
          i < numQuantity;
          i++
        ) {
          const code =
            numQuantity === 1
              ? baseTicketCode
              : `${baseTicketCode}-${i + 1}`;

          const ticket =
            await tx.ticket.create({
              data: {
                event: {
                  connect: {
                    id: eventId,
                  },
                },

                user: customerId
                  ? {
                      connect: {
                        id: customerId,
                      },
                    }
                  : undefined,

                attendeeName,
                attendeeEmail,
                attendeePhone,
                ticketType,
                ticketCode: code,
                pricePaid:
                  singleTicketPricePaid,
              },

              include: {
                event: true,
              },
            });

          createdTickets.push(ticket);
        }

        // --------------------------------------------------
        // UPDATE SOLD COUNT
        // --------------------------------------------------

        await tx.ticketType.updateMany({
          where: {
            eventId,
            name: ticketType,
          },

          data: {
            sold: {
              increment: numQuantity,
            },
          },
        });

        // --------------------------------------------------
        // CREDIT ORGANIZER
        // --------------------------------------------------

        if (createdTickets.length > 0) {
          await creditOrganizerWallet(
            createdTickets[0].event.organizerId,
            totalPrice,
            createdTickets[0].id,
            createdTickets[0].event.id,
            tx
          );
        }

        return createdTickets;
      },
      {
        maxWait: 10000,
        timeout: 30000,
      }
    );

    // --------------------------------------------------
    // PRIMARY TICKET
    // --------------------------------------------------

    const primaryTicket = result[0];

    const primaryCode =
      primaryTicket.ticketCode;

    const qrDataUrl =
      await generateTicketQrDataUrl(
        primaryCode
      );

    // --------------------------------------------------
    // EMAIL
    // --------------------------------------------------

    const emailResult =
      await sendEmailNotification({
        attendeeEmail,
        attendeeName,
        eventTitle:
          primaryTicket.event?.title ||
          "Event",

        eventDate:
          primaryTicket.event?.date
            ? new Date(
                primaryTicket.event.date
              ).toLocaleDateString(
                "en-US",
                {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }
              )
            : "Upcoming Event",

        eventLocation:
          primaryTicket.event?.location ||
          "Venue Location",

        ticketType,
        ticketCode: primaryCode,
        quantity: result.length,
        totalPricePaid: totalPrice,
        qrDataUrl,
      });

    // --------------------------------------------------
    // SMS
    // --------------------------------------------------

    const smsResult =
      await sendSmsNotification({
        attendeePhone,
        attendeeName,
        eventTitle:
          primaryTicket.event?.title ||
          "Event",
        ticketType,
        ticketCode: primaryCode,
        quantity: result.length,
      });

    // --------------------------------------------------
    // RESPONSE
    // --------------------------------------------------

    return res.json({
      ...primaryTicket,

      primaryCode,

      count: result.length,

      // IMPORTANT:
      // Return every ticket separately.
      allTickets: result,

      qrDataUrl,

      notifications: {
        email: emailResult,
        sms: smsResult,
      },
    });
  } catch (err: any) {
    console.error(
      "Booking error:",
      err
    );

    return res.status(500).json({
      error:
        err?.message ||
        "Failed to create booking",
    });
  }
});

  // ============================================================
  // ORGANIZER WALLET
  // ============================================================

  app.get(
    "/api/organizer/wallet/:userId",
    async (req, res) => {
      const { userId } = req.params;

      try {
        const organizer =
          await prisma.organizer.findUnique({
            where: {
              userId,
            },
          });

        if (!organizer) {
          return res.json({
            balance: 0,
            pendingBalance: 0,
            pendingWithdrawals: 0,
            totalWithdrawn: 0,
            riskLevel: "low",
            withdrawalsDisabled: false,
          });
        }

        let wallet =
          await prisma.organizerWallet.findUnique({
            where: {
              organizerId: organizer.id,
            },
          });

        if (!wallet) {
          wallet =
            await prisma.organizerWallet.create({
              data: {
                organizerId: organizer.id,
                availableBalance: 0,
                pendingBalance: 0,
              },
            });
        }

        res.json({
          balance: Number(
            wallet.availableBalance
          ),

          pendingBalance: Number(
            wallet.pendingBalance
          ),

          pendingWithdrawals: Number(
            wallet.pendingBalance
          ),

          totalWithdrawn: Number(
            wallet.totalWithdrawn
          ),

          riskLevel:
            organizer.riskLevel,

          withdrawalsDisabled:
            organizer.withdrawalsDisabled,
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // ORGANIZER TRANSACTIONS
  // ============================================================

  app.get(
    "/api/organizer/transactions/:userId",
    async (req, res) => {
      const { userId } = req.params;

      try {
        const organizer =
          await prisma.organizer.findUnique({
            where: {
              userId,
            },
          });

        if (!organizer) {
          return res.json([]);
        }

        const transactions =
          await prisma.walletTransaction.findMany({
            where: {
              organizerId: organizer.id,
            },

            orderBy: {
              createdAt: "desc",
            },
          });

        res.json(transactions);
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // PAYOUT REQUEST
  // ============================================================

  app.post(
    "/api/payouts/request",
    async (req, res) => {
      const {
        organizerId,
        amount,
        provider,
        phone,
      } = req.body;

      try {
        const withdrawal =
          await requestWithdrawal(
            organizerId,
            amount,
            provider,
            phone
          );

        res.json({
          status: "Pending",

          message:
            "Payout request of $" +
            amount +
            " received. Admin approval required.",

          requestId: withdrawal.id,
        });
      } catch (err: any) {
        res.status(403).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // ADMIN USERS
  // ============================================================

  app.get("/api/admin/users", async (req, res) => {
    try {
      const users =
        await prisma.user.findMany({
          orderBy: {
            createdAt: "desc",
          },
        });

      res.json(
        users.map((u) => ({
          uid: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
        }))
      );
    } catch (err: any) {
      res.status(500).json({
        error: err.message,
      });
    }
  });

  // ============================================================
  // ADMIN CHANGE USER ROLE
  // ============================================================

  app.post(
    "/api/admin/users/:uid/role",
    async (req, res) => {
      const { uid } = req.params;
      const { role } = req.body;

      try {
        if (
          !["Customer", "Organizer", "Admin"].includes(
            role
          )
        ) {
          return res.status(400).json({
            error: "Invalid role",
          });
        }

        await prisma.user.update({
          where: {
            id: uid,
          },

          data: {
            role,
          },
        });

        res.json({
          success: true,
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // DELETE EVENT
  // ============================================================

  app.delete(
    "/api/events/:id",
    async (req, res) => {
      const { id } = req.params;

      try {
        await prisma.ticketType.deleteMany({
          where: {
            eventId: id,
          },
        });

        await prisma.ticket.deleteMany({
          where: {
            eventId: id,
          },
        });

        await prisma.event.delete({
          where: {
            id,
          },
        });

        res.json({
          success: true,
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // ADMIN PENDING PAYOUTS
  // ============================================================

  app.get(
    "/api/admin/payouts/pending",
    async (req, res) => {
      try {
        const withdrawals =
          await prisma.withdrawal.findMany({
            where: {
              status: "pending",
            },

            include: {
              organizer: true,
            },

            orderBy: {
              createdAt: "desc",
            },
          });

        res.json(
          withdrawals.map((w) => ({
            id: w.id,
            organizerId: w.organizerId,
            organizerName:
              w.organizer.name,
            amount: w.amount,
            provider: w.provider,
            phone: w.phone,
            status: w.status,
            createdAt: w.createdAt,
          }))
        );
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // ADMIN PROCESS PAYOUT
  // ============================================================

  app.post(
    "/api/admin/payouts/process",
    async (req, res) => {
      const {
        withdrawalId,
        status,
      } = req.body;

      try {
        await processWithdrawal(
          withdrawalId,
          status
        );

        res.json({
          success: true,

          message:
            `Withdrawal ${withdrawalId} marked as ${status}`,
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // ADMIN RELEASE EVENT RESERVE
  // ============================================================

  app.post(
    "/api/admin/events/:id/release",
    async (req, res) => {
      const { id } = req.params;

      try {
        const result =
          await releaseEventReserve(id);

        res.json(result);
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // TICKET VERIFICATION
  // ============================================================

  app.get(
    "/api/tickets/verify/:code",
    async (req, res) => {
      const { code } = req.params;

      try {
        const ticket =
          await prisma.ticket.findUnique({
            where: {
              ticketCode: code,
            },

            include: {
              event: {
                include: {
                  organizer: true,
                },
              },
            },
          });

        if (!ticket) {
          return res.status(404).json({
            status: "INVALID",
            valid: false,
            message:
              "Ticket code does not exist in Swift Tickets system.",
          });
        }

        let validStatus = "VALID";
        let message =
          "Official Valid Ticket";

        if (ticket.status === "Scanned") {
          validStatus =
            "ALREADY_SCANNED";

          message =
            `Ticket was already scanned at ${
              ticket.scannedGate ||
              "Main Gate"
            } on ${
              ticket.scannedAt
                ? new Date(
                    ticket.scannedAt
                  ).toLocaleTimeString()
                : "event date"
            }.`;
        } else if (
          ticket.status === "Refunded" ||
          ticket.status === "Cancelled"
        ) {
          validStatus = "REFUNDED";

          message =
            "This ticket was cancelled or refunded.";
        } else if (
          ticket.status === "Transferred"
        ) {
          validStatus = "TRANSFERRED";

          message =
            "This ticket was transferred to another buyer and this old QR code is invalidated.";
        }

        res.json({
          valid:
            validStatus === "VALID",

          status: validStatus,

          message,

          ticketCode:
            ticket.ticketCode,

          attendeeName:
            ticket.attendeeName,

          ticketType:
            ticket.ticketType,

          eventTitle:
            ticket.event.title,

          eventDate:
            ticket.event.date,

          eventLocation:
            ticket.event.location,

          organizerName:
            ticket.event.organizer.name,

          scannedAt:
            ticket.scannedAt,

          scannedGate:
            ticket.scannedGate,
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // TICKET TRANSFER
  // ============================================================

  app.post(
    "/api/tickets/transfer",
    async (req, res) => {
      const {
        ticketCode,
        newRecipientName,
        newRecipientEmail,
        newRecipientPhone,
      } = req.body;

      try {
        if (
          !ticketCode ||
          !newRecipientName ||
          !newRecipientEmail
        ) {
          return res.status(400).json({
            error:
              "Ticket code, recipient name, and recipient email are required",
          });
        }

        const ticket =
          await prisma.ticket.findUnique({
            where: {
              ticketCode,
            },

            include: {
              event: true,
            },
          });

        if (!ticket) {
          return res.status(404).json({
            error: "Ticket not found",
          });
        }

        if (ticket.status !== "Active") {
          return res.status(400).json({
            error:
              `Cannot transfer ticket with status: ${ticket.status}`,
          });
        }

        const newTicketCode =
          `SWIFT-XFER-${Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase()}-${Date.now()
            .toString()
            .slice(-4)}`;

        await prisma.ticket.update({
          where: {
            id: ticket.id,
          },

          data: {
            attendeeName:
              newRecipientName,

            attendeeEmail:
              newRecipientEmail,

            attendeePhone:
              newRecipientPhone || null,

            ticketCode:
              newTicketCode,

            status: "Active",
          },
        });

        const qrDataUrl =
          await generateTicketQrDataUrl(
            newTicketCode
          );

        const emailResult =
          await sendEmailNotification({
            attendeeEmail:
              newRecipientEmail,

            attendeeName:
              newRecipientName,

            eventTitle:
              ticket.event.title,

            eventDate:
              new Date(
                ticket.event.date
              ).toLocaleDateString(),

            eventLocation:
              ticket.event.location,

            ticketType:
              ticket.ticketType,

            ticketCode:
              newTicketCode,

            quantity: 1,

            totalPricePaid:
              ticket.pricePaid,

            qrDataUrl,
          });

        const smsResult =
          await sendSmsNotification({
            attendeePhone:
              newRecipientPhone || "",

            attendeeName:
              newRecipientName,

            eventTitle:
              ticket.event.title,

            ticketType:
              ticket.ticketType,

            ticketCode:
              newTicketCode,

            quantity: 1,
          });

        res.json({
          success: true,

          message:
            `Ticket transferred to ${newRecipientName}. Old QR invalidated and new ticket issued!`,

          oldTicketCode:
            ticketCode,

          newTicketCode,

          qrDataUrl,

          notifications: {
            email: emailResult,
            sms: smsResult,
          },
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // USER TICKET LIBRARY
  // ============================================================

app.get(
  "/api/tickets/user/:emailOrId",
  async (req, res) => {
    const { emailOrId } = req.params;

    try {
      if (!emailOrId) {
        return res.status(400).json({
          error: "User ID or email is required",
        });
      }

      console.log(
        "FETCHING TICKETS FOR:",
        emailOrId
      );

      // --------------------------------------------------
      // FIND USER
      // --------------------------------------------------

      const userById =
        await prisma.user.findUnique({
          where: {
            id: emailOrId,
          },
        }).catch(() => null);

      const userByEmail =
        !userById
          ? await prisma.user.findUnique({
              where: {
                email: emailOrId,
              },
            }).catch(() => null)
          : null;

      const user =
        userById || userByEmail;

      console.log(
        "TICKET USER FOUND:",
        user
          ? {
              id: user.id,
              email: user.email,
              name: user.name,
            }
          : null
      );

      // --------------------------------------------------
      // BUILD SEARCH
      // --------------------------------------------------

      const ticketConditions: any[] = [
        {
          userId: emailOrId,
        },
        {
          attendeeEmail: emailOrId,
        },
      ];

      // If we found the user, also search using
      // their actual ID and email.
      if (user) {
        ticketConditions.push({
          userId: user.id,
        });

        if (user.email) {
          ticketConditions.push({
            attendeeEmail: user.email,
          });
        }
      }

      // Remove duplicate conditions
      const uniqueConditions =
        ticketConditions.filter(
          (condition, index, array) =>
            index ===
            array.findIndex(
              (item) =>
                JSON.stringify(item) ===
                JSON.stringify(condition)
            )
        );

      // --------------------------------------------------
      // GET ALL TICKETS
      // --------------------------------------------------

      const tickets =
        await prisma.ticket.findMany({
          where: {
            OR: uniqueConditions,
          },

          include: {
            event: true,
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      console.log(
        "TOTAL TICKETS FOUND:",
        tickets.length
      );

      console.log(
        "TICKET IDS:",
        tickets.map((ticket) => ({
          id: ticket.id,
          code: ticket.ticketCode,
          userId: ticket.userId,
          email: ticket.attendeeEmail,
          eventId: ticket.eventId,
        }))
      );

      const now = new Date();

      // --------------------------------------------------
      // UPCOMING
      // --------------------------------------------------

      const upcoming =
        tickets.filter(
          (ticket) =>
            ticket.status === "Active" &&
            ticket.event &&
            new Date(ticket.event.date) >= now
        );

      // --------------------------------------------------
      // PAST
      // --------------------------------------------------

      const past =
        tickets.filter(
          (ticket) =>
            ticket.status === "Scanned" ||
            (
              ticket.status === "Active" &&
              ticket.event &&
              new Date(ticket.event.date) < now
            )
        );

      // --------------------------------------------------
      // REFUNDED
      // --------------------------------------------------

      const refunded =
        tickets.filter(
          (ticket) =>
            ticket.status === "Refunded" ||
            ticket.status === "Cancelled"
        );

      // --------------------------------------------------
      // TRANSFERRED
      // --------------------------------------------------

      const transferred =
        tickets.filter(
          (ticket) =>
            ticket.status === "Transferred"
        );

      return res.json({
        all: tickets,
        upcoming,
        past,
        refunded,
        transferred,
        count: tickets.length,
      });
    } catch (err: any) {
      console.error(
        "Fetch user tickets error:",
        err
      );

      return res.status(500).json({
        error:
          err?.message ||
          "Failed to fetch tickets",
      });
    }
  }
);

  // ============================================================
  // OFFLINE GATE MANIFEST
  // ============================================================

  app.get(
    "/api/events/:id/gate-manifest",
    async (req, res) => {
      const { id } = req.params;

      try {
        const tickets =
          await prisma.ticket.findMany({
            where: {
              eventId: id,
            },

            select: {
              id: true,
              ticketCode: true,
              attendeeName: true,
              ticketType: true,
              status: true,
              scannedAt: true,
              scannedGate: true,
            },
          });

        res.json({
          eventId: id,
          totalTickets:
            tickets.length,
          tickets,
          downloadedAt:
            new Date().toISOString(),
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // BOX OFFICE DOOR SALE
  // ============================================================

  app.post(
    "/api/scanner/door-sale",
    async (req, res) => {
      const {
        eventId,
        ticketType,
        attendeeName,
        attendeeEmail,
        attendeePhone,
      } = req.body;

      try {
        const event =
          await prisma.event.findUnique({
            where: {
              id: eventId,
            },

            include: {
              ticketTypes: true,
            },
          });

        if (!event) {
          return res.status(404).json({
            error: "Event not found",
          });
        }

        const tt =
          event.ticketTypes.find(
            (t) => t.name === ticketType
          );

        const price = tt
          ? tt.price
          : 0;

        const doorCode =
          `SWIFT-DOOR-${Math.random()
            .toString(36)
            .substring(2, 8)
            .toUpperCase()}`;

        const ticket =
          await prisma.ticket.create({
            data: {
              eventId,

              attendeeName:
                attendeeName ||
                "Door Walk-In",

              attendeeEmail:
                attendeeEmail ||
                "door@swifttickets.lr",

              attendeePhone:
                attendeePhone || null,

              ticketType,

              ticketCode:
                doorCode,

              pricePaid: price,

              status: "Scanned",

              scannedAt: new Date(),

              scannedGate:
                "Box Office Gate",
            },
          });

        const qrDataUrl =
          await generateTicketQrDataUrl(
            doorCode
          );

        res.json({
          success: true,

          message:
            "Door ticket sold & validated instantly!",

          ticket,

          qrDataUrl,
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

  // ============================================================
  // ORGANIZER CRM
  // ============================================================

  app.get(
    "/api/organizer/crm/:userId",
    async (req, res) => {
      const { userId } = req.params;

      try {
        const organizer =
          await prisma.organizer.findUnique({
            where: {
              userId,
            },

            include: {
              events: {
                include: {
                  tickets: true,
                },
              },
            },
          });

        if (!organizer) {
          return res.status(404).json({
            error: "Organizer not found",
          });
        }

        const allTickets =
          organizer.events.flatMap(
            (e) => e.tickets
          );

        const customerMap =
          new Map<
            string,
            {
              name: string;
              email: string;
              phone?: string;
              totalTickets: number;
              totalSpent: number;
            }
          >();

        allTickets.forEach((t) => {
          const key =
            t.attendeeEmail.toLowerCase();

          const existing =
            customerMap.get(key);

          if (existing) {
            existing.totalTickets += 1;

            existing.totalSpent +=
              Number(t.pricePaid);
          } else {
            customerMap.set(key, {
              name: t.attendeeName,

              email:
                t.attendeeEmail,

              phone:
                t.attendeePhone ||
                undefined,

              totalTickets: 1,

              totalSpent:
                Number(t.pricePaid),
            });
          }
        });

        const customers =
          Array.from(
            customerMap.values()
          ).sort(
            (a, b) =>
              b.totalSpent -
              a.totalSpent
          );

        const vipCustomers =
          customers.filter(
            (c) =>
              c.totalSpent >= 50 ||
              c.totalTickets >= 3
          );

        const repeatAttendees =
          customers.filter(
            (c) =>
              c.totalTickets > 1
          );

        res.json({
          totalEvents:
            organizer.events.length,

          totalTicketsSold:
            allTickets.length,

          uniqueCustomersCount:
            customers.length,

          vipCustomers,

          repeatAttendeesCount:
            repeatAttendees.length,

          topCustomers:
            customers.slice(0, 10),
        });
      } catch (err: any) {
        res.status(500).json({
          error: err.message,
        });
      }
    }
  );

// ============================================================
// SCANNER - ACTIVE EVENTS
// ============================================================

app.get(
  "/api/scanner/events/active/:userId",
  async (req, res) => {
    const { userId } = req.params;

    try {
      console.log(
        "SCANNER ACTIVE EVENTS REQUEST:",
        userId
      );

      if (!userId) {
        return res.status(400).json({
          error: "User ID is required",
        });
      }

      // Find the organizer belonging to this user
      const organizer =
        await prisma.organizer.findUnique({
          where: {
            userId,
          },
        });

      if (!organizer) {
        console.log(
          "SCANNER ORGANIZER NOT FOUND:",
          userId
        );

        return res.json([]);
      }

      // Find published events belonging to this organizer
      const events =
        await prisma.event.findMany({
          where: {
            organizerId: organizer.id,
            status: "Published",
          },

          include: {
            ticketTypes: true,
          },

          orderBy: {
            date: "asc",
          },
        });

      console.log(
        "SCANNER ACTIVE EVENTS FOUND:",
        events.length
      );

      return res.json(events);
    } catch (err: any) {
      console.error(
        "Fetch scanner active events error:",
        err
      );

      return res.status(500).json({
        error:
          err?.message ||
          "Failed to fetch active events",
      });
    }
  }
);


// ============================================================
// SCANNER - SCAN / VALIDATE TICKET
// ============================================================

app.post(
  "/api/scanner/scan",
  async (req, res) => {
    const {
      ticketCode,
      code,
      eventId,
      gate,
      scannedGate,
    } = req.body;

    // Support both ticketCode and code
    const scanCode =
      String(ticketCode || code || "").trim();

    const gateName =
      String(
        scannedGate ||
        gate ||
        "Main Gate"
      ).trim();

    try {
      console.log("SCANNER SCAN REQUEST:", {
        ticketCode: scanCode,
        eventId,
        gate: gateName,
      });

      if (!scanCode) {
        return res.status(400).json({
          valid: false,
          status: "INVALID",
          error: "Ticket code is required",
          message: "Please scan a valid ticket QR code.",
        });
      }

      // --------------------------------------------------
      // FIND TICKET
      // --------------------------------------------------

      const ticket =
        await prisma.ticket.findUnique({
          where: {
            ticketCode: scanCode,
          },

          include: {
            event: {
              include: {
                organizer: true,
              },
            },
          },
        });

      // --------------------------------------------------
      // TICKET DOES NOT EXIST
      // --------------------------------------------------

      if (!ticket) {
        console.log(
          "SCANNER: TICKET NOT FOUND:",
          scanCode
        );

        return res.status(404).json({
          valid: false,
          status: "INVALID",
          ticketCode: scanCode,
          message:
            "Invalid ticket. This ticket does not exist in Swift Tickets.",
        });
      }

      // --------------------------------------------------
      // OPTIONAL EVENT CHECK
      // --------------------------------------------------

      if (
        eventId &&
        ticket.eventId !== eventId
      ) {
        console.log(
          "SCANNER: WRONG EVENT:",
          {
            ticketEventId: ticket.eventId,
            scannedEventId: eventId,
          }
        );

        return res.status(400).json({
          valid: false,
          status: "WRONG_EVENT",
          ticketCode: ticket.ticketCode,
          message:
            "This ticket belongs to a different event.",
          eventTitle:
            ticket.event?.title,
        });
      }

      // --------------------------------------------------
      // ALREADY SCANNED
      // --------------------------------------------------

      if (ticket.status === "Scanned") {
        return res.status(409).json({
          valid: false,
          status: "ALREADY_SCANNED",
          ticketCode: ticket.ticketCode,

          message:
            `Ticket was already scanned at ${
              ticket.scannedGate ||
              "Main Gate"
            }${
              ticket.scannedAt
                ? ` on ${new Date(
                    ticket.scannedAt
                  ).toLocaleString()}`
                : ""
            }.`,

          attendeeName:
            ticket.attendeeName,

          ticketType:
            ticket.ticketType,

          eventTitle:
            ticket.event?.title,

          eventDate:
            ticket.event?.date,

          eventLocation:
            ticket.event?.location,

          scannedAt:
            ticket.scannedAt,

          scannedGate:
            ticket.scannedGate,
        });
      }

      // --------------------------------------------------
      // REFUNDED / CANCELLED
      // --------------------------------------------------

      if (
        ticket.status === "Refunded" ||
        ticket.status === "Cancelled"
      ) {
        return res.status(400).json({
          valid: false,
          status: "REFUNDED",
          ticketCode: ticket.ticketCode,

          message:
            "This ticket has been cancelled or refunded and cannot be used.",

          attendeeName:
            ticket.attendeeName,

          ticketType:
            ticket.ticketType,

          eventTitle:
            ticket.event?.title,
        });
      }

      // --------------------------------------------------
      // TRANSFERRED
      // --------------------------------------------------

      if (ticket.status === "Transferred") {
        return res.status(400).json({
          valid: false,
          status: "TRANSFERRED",
          ticketCode: ticket.ticketCode,

          message:
            "This ticket has been transferred and this QR code is no longer valid.",

          attendeeName:
            ticket.attendeeName,

          ticketType:
            ticket.ticketType,

          eventTitle:
            ticket.event?.title,
        });
      }

      // --------------------------------------------------
      // ONLY ACTIVE TICKETS CAN BE SCANNED
      // --------------------------------------------------

      if (ticket.status !== "Active") {
        return res.status(400).json({
          valid: false,
          status: String(
            ticket.status
          ).toUpperCase(),

          ticketCode:
            ticket.ticketCode,

          message:
            `This ticket cannot be scanned because its current status is ${ticket.status}.`,
        });
      }

      // --------------------------------------------------
      // MARK TICKET AS SCANNED
      // --------------------------------------------------

      const scannedAt = new Date();

      const scannedTicket =
        await prisma.ticket.update({
          where: {
            id: ticket.id,
          },

          data: {
            status: "Scanned",
            scannedAt,
            scannedGate: gateName,
          },

          include: {
            event: {
              include: {
                organizer: true,
              },
            },
          },
        });

      console.log(
        "SCANNER: TICKET ACCEPTED:",
        scannedTicket.ticketCode
      );

      // --------------------------------------------------
      // SUCCESS RESPONSE
      // --------------------------------------------------

      return res.json({
        valid: true,
        status: "VALID",

        message:
          "Ticket verified successfully. Welcome!",

        ticketCode:
          scannedTicket.ticketCode,

        attendeeName:
          scannedTicket.attendeeName,

        attendeeEmail:
          scannedTicket.attendeeEmail,

        attendeePhone:
          scannedTicket.attendeePhone,

        ticketType:
          scannedTicket.ticketType,

        eventTitle:
          scannedTicket.event?.title,

        eventDate:
          scannedTicket.event?.date,

        eventLocation:
          scannedTicket.event?.location,

        organizerName:
          scannedTicket.event?.organizer?.name,

        scannedAt:
          scannedTicket.scannedAt,

        scannedGate:
          scannedTicket.scannedGate,
      });
    } catch (err: any) {
      console.error(
        "========== SCANNER ERROR =========="
      );
      console.error(err);
      console.error(
        "==================================="
      );

      return res.status(500).json({
        valid: false,
        status: "ERROR",

        error:
          err?.message ||
          "Failed to scan ticket",
      });
    }
  }
);
  // ============================================================
  // VITE
  // ============================================================

  if (
    process.env.NODE_ENV !==
    "production"
  ) {
    const vite =
      await createViteServer({
        server: {
          middlewareMode: true,
        },

        appType: "spa",
      });

    app.use(vite.middlewares);
  } else {
    const distPath =
      path.join(
        process.cwd(),
        "dist"
      );

    app.use(
      express.static(distPath)
    );

    app.get("*", (req, res) => {
      res.sendFile(
        path.join(
          distPath,
          "index.html"
        )
      );
    });
  }

  
  // ============================================================
  // START SERVER
  // ============================================================


  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Server running on http://localhost:${PORT}`
      );
    }
  );
}

startServer();