# Vercel Deployment Guide

## Prerequisites

1. Vercel account (free tier works)
2. GitHub repo connected

## Step 1: Add Neon Database

1. Go to [vercel.com](https://vercel.com) and create/select your project
2. Go to **Storage** or **Integrations** → **Add Integration**
3. Search for **Neon** and install
4. Create a new database and link it to your project
5. Vercel will automatically add `POSTGRES_URL` or `DATABASE_URL` to your environment variables

## Step 2: Set Environment Variables

In Vercel Project → **Settings** → **Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `SECRET` | A random string (32+ characters) for cookie signing |
| `DASHBOARD_PASSWORD` | Your dashboard login password |
| `DATABASE_URL` or `POSTGRES_URL` | Auto-added by Neon integration |

## Step 3: Deploy

- **Option A:** Push to GitHub – Vercel deploys automatically
- **Option B:** Run `vercel` or `vercel --prod` from the project root

## Local Development

For local development with Postgres:

1. Create a Neon database (or use any Postgres)
2. Copy `.env.example` to `.env`
3. Set `DATABASE_URL` or `POSTGRES_URL` in `.env`
4. Run `npm start`

To simulate Vercel locally: `vercel dev`
