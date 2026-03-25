import { User } from "../models/user.models.js";
import axios from "axios";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";


dotenv.config({});

export const githubLogin = async (req, res) => {
    try {
        const code = req.query.code;

        if (!code) {
            return res.status(400).json({ error: "Code not provided" });
        }

        // 🔹 1. Get access token
        const tokenRes = await axios.post(
            "https://github.com/login/oauth/access_token",
            {
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code,
            },
            {
                headers: { Accept: "application/json" },
            }
        );

        const access_token = tokenRes.data.access_token;

        if (!access_token) {
            return res.status(400).json({ error: "Failed to get access token" });
        }

        // 🔹 2. Get GitHub user
        const userRes = await axios.get("https://api.github.com/user", {
            headers: {
                Authorization: `Bearer ${access_token}`,
            },
        });

        // 🔹 3. Get emails
        const emailRes = await axios.get(
            "https://api.github.com/user/emails",
            {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                },
            }
        );

        const primaryEmail =
            emailRes.data.find((e) => e.primary)?.email ||
            userRes.data.email;

        if (!primaryEmail) {
            return res.status(400).json({ error: "Email not found" });
        }

        // 🔹 4. Fetch ALL repos with pagination
        let allRepos = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const repoRes = await axios.get(
                `https://api.github.com/user/repos?per_page=100&page=${page}`,
                {
                    headers: {
                        Authorization: `Bearer ${access_token}`,
                    },
                }
            );

            allRepos = [...allRepos, ...repoRes.data];

            if (repoRes.data.length < 100) {
                hasMore = false;
            } else {
                page++;
            }
        }

        // 🔹 5. Find or create user
        let user = await User.findOne({ email: primaryEmail });

        if (!user) {
            user = new User({
                fullname: userRes.data.name || userRes.data.login,
                email: primaryEmail,
                repos: [],
            });
        }

        // 🔥 ALWAYS UPDATE REPOS (IMPORTANT FIX)
        user.repos = allRepos.map((repo) => ({
            repoId: repo.id, // better for uniqueness
            name: repo.name,
            clone_url: repo.clone_url,
            private: repo.private,
            created_at: repo.created_at,
        }));

        await user.save();

        // 🔹 6. Create JWT
        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // 🔹 7. Store in cookie
        res.cookie("token", token, {
            httpOnly: true,
            secure: true,       // must be HTTPS
            sameSite: "none",   // cross-origin
            maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        // 🔹 8. Redirect
        return res.redirect(`${process.env.CALLBACK}/dashboard`);

    } catch (error) {
        console.error("GitHub Auth Error:", error.response?.data || error.message);
        return res.status(500).json({ error: "Auth failed" });
    }
};


export const getCurrentUser = async (req, res) => {
    console.log("Cookies:", req.cookies);
    const user = await User.findById(req.user.id);
    res.json(user);
}

export const logout = (req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        secure: false, // true in production (HTTPS)
        sameSite: "lax",
    });

    return res.status(200).json({ message: "Logged out successfully" });
};
