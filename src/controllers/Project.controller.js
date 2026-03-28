import { User } from "../models/user.models.js";


export const StoreProject = async (req, res) => {
    try {
        const userId = req.user.id;
        const { project_url, slug, repoName } = req.body;
 
        if (!project_url || !slug || !repoName) {
            return res.status(400).json({ msg: "Missing fields" });
        }
 
        const result = await User.updateOne(
            { _id: userId, "repos.name": repoName }, // ✅ "name" matches schema
            {
                $push: {
                    "repos.$.Projects": {
                        project_url,
                        slug
                    }
                }
            }
        );
 
        if (result.modifiedCount === 0) {
            return res.status(404).json({ msg: "Repo not found" });
        }
 
        return res.status(200).json({
            msg: "Project stored successfully"
        });
 
    } catch (error) {
        console.log(error);
        return res.status(500).json({ error: error.message });
    }
};
 
export const GetAllProjectsFlat = async (req, res) => {
    try {
        const userId = req.user.id;
 
        const user = await User.findById(userId).select("repos");
 
        if (!user) {
            return res.status(404).json({ msg: "User not found" });
        }
 
        // ✅ flatten all projects
        const allProjects = [];
 
        user.repos.forEach(repo => {
            repo.Projects.forEach(project => {
                allProjects.push({
                    ...project.toObject(),
                    repoName: repo.name  // ✅ was repo.repoName, schema field is "name"
                });
            });
        });
 
        return res.status(200).json({
            projects: allProjects
        });
 
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};
